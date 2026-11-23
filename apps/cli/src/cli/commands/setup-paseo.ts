import { configurePaseo, type PaseoSetupOptions } from "../../integrations/paseo.ts";
import { replacementConfirmation } from "./integration-setup.ts";

export async function runPaseoSetup(
  options: PaseoSetupOptions,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const result = await configurePaseo({
    ...options,
    environment,
    cwd,
    ...replacementConfirmation(
      environment,
      (configPath) =>
        `Update Axon setup in ${configPath} (enable relay and integration features, configure the terminal profile, and disable other built-in providers)?`,
    ),
  });

  if (result.status === "cancelled") {
    console.log("Paseo setup cancelled; config left unchanged.");
    return;
  }
  if (result.status === "unchanged") {
    console.log(
      `Paseo already has the Axon provider and integration settings configured: ${result.configPath}`,
    );
    return;
  }
  console.log(`Paseo Axon provider configured: ${result.configPath}`);
  if (result.backupPath !== undefined)
    console.log(`Previous config backed up to: ${result.backupPath}`);
  console.log(
    "Enabled dictation, voice mode, plugins, MCP injection, browser tools, and terminal agent hooks.",
  );
  console.log("Enabled Paseo relay for remote connectivity.");
  console.log("Configured the Axon terminal profile: axon pi {{{prompt}}}");
  console.log("Disabled Pi, OpenCode, Copilot, Codex, Claude, Muse, and Antigravity providers.");
  console.log(
    "Restart Paseo to load the integration settings, then select Axon when starting a new chat.",
  );
}
