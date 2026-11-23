import { confirm, isCancel } from "@clack/prompts";

import { currentPiInvocationEnvironment } from "../../harnesses/pi/setup/packages/invocation.ts";

/**
 * In a terminal, asks before replacing an existing Axon entry (default No). Scripts
 * and CI get no prompt, so setup refuses unless `--yes` was passed.
 */
export function replacementConfirmation(
  environment: NodeJS.ProcessEnv,
  message: (configPath: string) => string,
): { readonly confirmReplacement?: (configPath: string) => Promise<boolean> } {
  const invocation = currentPiInvocationEnvironment(environment);
  if (invocation.ci || !invocation.stdinIsTty || !invocation.stdoutIsTty) return {};
  return {
    confirmReplacement: async (configPath: string) => {
      const answer = await confirm({ message: message(configPath), initialValue: false });
      return !isCancel(answer) && answer === true;
    },
  };
}
