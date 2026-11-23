import { spawn } from "node:child_process";

/** Ask the OS browser to open an already-validated URL; never invoke a shell. */
export async function openBrowser(url: string, signal?: AbortSignal): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "ignore", signal });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Could not open the browser"));
    });
  });
}
