import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { runAuthLogin } from "../commands/auth.ts";
import { InvalidSessionContentError, loadEncryptedSession } from "./session.ts";
import { verifyEncryptedSession } from "./verification.ts";

export interface EnsureSessionOptions {
  readonly offline?: boolean;
  readonly interactive?: boolean;
  /**
   * Launch without a login and let the chat offer sign-in. Only for RPC clients,
   * which render Pi's standard dialogs themselves.
   */
  readonly deferLogin?: boolean;
}

/**
 * `"deferred"` launches signed out and the chat offers sign-in (see `deferLogin`);
 * `"cancelled"` means the user dismissed interactive login.
 */
export type SessionCheck = "verified" | "deferred" | "cancelled";

export async function ensureAuthenticatedSession(
  paths: AxonPaths,
  options: EnsureSessionOptions = {},
): Promise<SessionCheck> {
  // A saved token alone is not proof of access. Offline mode cannot bypass verification.
  if (options.offline) {
    throw new LauncherError(
      "Cannot verify your Axon session while offline",
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation: "Run axon or axon pi while online to verify your session before starting Pi.",
      },
    );
  }

  let encryptedSession: string | undefined;
  try {
    encryptedSession = await loadEncryptedSession(paths);
  } catch (error) {
    // Login can repair corrupt contents, but not unsafe entries or storage failures.
    if (!(error instanceof InvalidSessionContentError)) {
      throw new LauncherError(
        "Your saved Axon session could not be read safely",
        LAUNCHER_EXIT_STATUS.profileFailure,
        { remediation: "Check the shared authentication file and its permissions, then retry." },
      );
    }
  }

  if (encryptedSession !== undefined) {
    const status = await verifyEncryptedSession(encryptedSession, paths);
    if (status === "VERIFIED") return "verified";
    console.error(
      status === "EXPIRED" ? "Your Axon session has expired." : "Your Axon session is invalid.",
    );
  } else {
    console.error("Sign in to Axon to continue.");
  }

  if (options.deferLogin) return "deferred";
  if (options.interactive === false || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new LauncherError("Axon login is required", LAUNCHER_EXIT_STATUS.profileFailure, {
      remediation: "Login from browser: run axon auth login --browser in a terminal.",
    });
  }

  // runAuthLogin presents a choice; it never opens a browser until selected.
  if (!(await runAuthLogin(paths, {}))) return "cancelled";
  const savedSession = await loadEncryptedSession(paths);
  if (
    savedSession !== undefined &&
    (await verifyEncryptedSession(savedSession, paths)) === "VERIFIED"
  ) {
    return "verified";
  }
  throw new LauncherError(
    "The browser session could not be verified",
    LAUNCHER_EXIT_STATUS.profileFailure,
    { remediation: "Run axon auth login and choose Login from browser to retry." },
  );
}
