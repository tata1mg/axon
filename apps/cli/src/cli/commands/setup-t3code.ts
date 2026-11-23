import { configureT3Code, type T3CodeSetupOptions } from "../../integrations/t3code.ts";
import { resolveAxonPaths } from "../../product/paths.ts";
import { replacementConfirmation } from "./integration-setup.ts";

export async function runT3CodeSetup(
  options: T3CodeSetupOptions,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const result = await configureT3Code({
    ...options,
    environment,
    cwd,
    ...replacementConfirmation(
      environment,
      (configPath) =>
        `Update the Axon provider in ${configPath} (run Pi through axon-pi and disable other built-in providers except Claude)?`,
    ),
  });

  if (result.status === "cancelled") {
    console.log("T3 Code setup cancelled; settings left unchanged.");
    return;
  }
  const wrapper = resolveAxonPaths(environment).piWrapper;
  if (result.status === "unchanged") {
    console.log(`T3 Code already has the Axon provider configured: ${result.configPath}`);
    console.log(`Pi wrapper: ${wrapper}`);
    return;
  }
  console.log(`T3 Code Axon provider configured: ${result.configPath}`);
  if (result.backupPath !== undefined)
    console.log(`Previous settings backed up to: ${result.backupPath}`);
  console.log(`Axon runs Pi through: ${wrapper}`);
  console.log(
    "Disabled Codex, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, and fx; Claude is unchanged.",
  );
  console.log(
    "T3 Code reloads its settings automatically; select Axon when starting a new thread.",
  );
}
