import { createContext, useContext } from "react";

import type { AdminSession } from "./types";

export type AdminAuthState =
  | { status: "loading" }
  | { status: "signed_out"; notice?: string }
  | { status: "unavailable"; message: string }
  | { status: "signed_in"; session: AdminSession };

export interface AdminAuth {
  state: AdminAuthState;
  /** Called by the sign-in flow once the backend has set the session cookie. */
  completeSignIn: (session: AdminSession) => void;
  /**
   * Resolves once the browser session is gone; rejects (still signed in) when the server
   * could not confirm that, so the caller can show the failure.
   */
  signOut: () => Promise<void>;
  /** Re-check the session, for example after the backend was unavailable. */
  refresh: () => void;
  /**
   * Route API errors through here: a 401 means the axon-auth session ended or access
   * was removed from config, so the dashboard returns to the sign-in screen.
   */
  handleApiError: (error: unknown) => string;
}

export const AdminAuthContext = createContext<AdminAuth | null>(null);

export function useAdminAuth(): AdminAuth {
  const auth = useContext(AdminAuthContext);
  if (!auth) throw new Error("useAdminAuth must be used inside AdminAuthProvider");
  return auth;
}

export function useAdminSession(): AdminSession {
  const { state } = useAdminAuth();
  if (state.status !== "signed_in") throw new Error("useAdminSession requires a signed-in user");
  return state.session;
}
