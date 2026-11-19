import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, adminRequest } from "@/lib/api";

import { AdminAuthContext, type AdminAuth, type AdminAuthState } from "./auth-context";
import type { AdminSession } from "./types";

const SESSION_ENDED = "Your session ended. Sign in again to continue.";

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminAuthState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    adminRequest<AdminSession>("GET", "/session").then(
      ({ data }) => {
        if (!cancelled) setState({ status: "signed_in", session: data });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setState({ status: "signed_out" });
        else if (error instanceof ApiError && error.status === 404)
          setState({ status: "unavailable", message: "The admin dashboard is not enabled." });
        else
          setState({
            status: "unavailable",
            message: error instanceof Error ? error.message : "Something went wrong.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [generation]);

  const refresh = useCallback(() => {
    setState({ status: "loading" });
    setGeneration((value) => value + 1);
  }, []);

  const completeSignIn = useCallback((session: AdminSession) => {
    setState({ status: "signed_in", session });
  }, []);

  const signOut = useCallback(async () => {
    let failure: unknown;
    try {
      await adminRequest("POST", "/logout");
      setState({ status: "signed_out" });
      return;
    } catch (error) {
      failure = error;
    }
    // The backend clears the cookie even on most errors. Only report "signed out" once
    // the server confirms the browser no longer holds a session.
    try {
      await adminRequest("GET", "/session");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const notice =
          failure instanceof ApiError && failure.status > 0 ? failure.message : undefined;
        setState(notice ? { status: "signed_out", notice } : { status: "signed_out" });
        return;
      }
    }
    const reason = failure instanceof Error ? ` ${failure.message}` : "";
    throw new Error(`Sign-out didn't finish, so this browser may still be signed in.${reason}`);
  }, []);

  const handleApiError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setState({ status: "signed_out", notice: SESSION_ENDED });
      return SESSION_ENDED;
    }
    return error instanceof Error ? error.message : "Something went wrong.";
  }, []);

  const value = useMemo<AdminAuth>(
    () => ({ state, completeSignIn, signOut, refresh, handleApiError }),
    [state, completeSignIn, signOut, refresh, handleApiError],
  );
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}
