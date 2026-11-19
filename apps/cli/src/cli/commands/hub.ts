import { startLocalHub } from "../../hub/server.ts";
import { openBrowser } from "../../launcher/browser.ts";
import type { AxonPaths } from "../../product/paths.ts";

/**
 * A standalone local tool: no Pi launch, sign-in flow, or upstream relay. It reads the
 * organization catalog with the saved Axon session, when there is one.
 */
export async function runHub(paths: AxonPaths, options: { open?: boolean } = {}): Promise<void> {
  const hub = startLocalHub(paths);
  let finish: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, finish);
  try {
    console.log("Axon Hub · your MCP servers, skills, and the organization catalog");
    console.log(hub.launchUrl);
    console.log(
      "Private, single-use link; expires in 5 minutes. Keep this terminal open. Press Ctrl+C to stop.",
    );
    if (options.open !== false) {
      try {
        await openBrowser(hub.launchUrl);
      } catch {
        console.error("Could not open your browser. Open the private link above manually.");
      }
    }
    await stopped;
  } finally {
    for (const signal of signals) process.off(signal, finish);
    await hub.stop();
  }
}
