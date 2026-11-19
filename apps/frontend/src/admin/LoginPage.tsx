import { ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, adminRequest } from "@/lib/api";

import { useAdminAuth } from "./auth-context";
import type { LoginPoll, LoginStart } from "./types";

const POLL_INTERVAL_MS = 2000;
// Transient upstream errors are retried; give up after this many in a row.
const MAX_CONSECUTIVE_FAILURES = 5;

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; browserUrl: string; tabOpened: boolean }
  | { kind: "failed"; message: string };

export function LoginPage({ notice }: { notice?: string }) {
  const { completeSignIn } = useAdminAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const attempt = useRef(0);

  // Stop any polling loop when the page unmounts.
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  async function poll(id: number, deadline: number) {
    let failures = 0;
    while (attempt.current === id) {
      if (Date.now() > deadline) {
        setPhase({ kind: "failed", message: "Sign-in timed out. Start again." });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (attempt.current !== id) return;
      try {
        const { data } = await adminRequest<LoginPoll>("POST", "/login/poll");
        failures = 0;
        if (data.status === "authenticated" && data.session) {
          attempt.current += 1;
          completeSignIn(data.session);
          return;
        }
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 0;
        const retryable = status === 0 || status >= 500;
        failures += 1;
        if (!retryable || failures >= MAX_CONSECUTIVE_FAILURES) {
          if (attempt.current === id) {
            setPhase({
              kind: "failed",
              message: error instanceof Error ? error.message : "Sign-in failed.",
            });
          }
          return;
        }
      }
    }
  }

  async function start() {
    const id = ++attempt.current;
    // Open the tab synchronously inside the click so popup blockers allow it.
    const tab = window.open("about:blank", "_blank");
    setPhase({ kind: "starting" });
    try {
      const { data } = await adminRequest<LoginStart>("POST", "/login");
      if (attempt.current !== id) {
        tab?.close();
        return;
      }
      if (tab) {
        tab.opener = null;
        tab.location.href = data.browser_url;
      }
      setPhase({ kind: "waiting", browserUrl: data.browser_url, tabOpened: tab !== null });
      void poll(id, Date.now() + data.expires_in_seconds * 1000);
    } catch (error) {
      tab?.close();
      setPhase({
        kind: "failed",
        message: error instanceof Error ? error.message : "Sign-in failed.",
      });
    }
  }

  function cancel() {
    attempt.current += 1;
    setPhase({ kind: "idle" });
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4 sm:p-6">
      <section
        aria-labelledby="admin-sign-in-title"
        className="bg-card w-full max-w-sm space-y-6 rounded-xl border p-6 shadow-xs"
      >
        <header className="space-y-2">
          <div className="bg-muted flex size-9 items-center justify-center rounded-lg">
            <ShieldCheck aria-hidden className="size-5" />
          </div>
          <h1
            id="admin-sign-in-title"
            className="font-heading text-xl font-semibold tracking-tight"
          >
            Axon admin
          </h1>
          <p className="text-muted-foreground text-sm">
            Sign in with your Axon account. Access is limited to people listed in the backend
            configuration.
          </p>
        </header>

        {notice && phase.kind === "idle" && (
          <p role="status" className="bg-muted rounded-md px-3 py-2 text-sm">
            {notice}
          </p>
        )}

        {phase.kind === "waiting" ? (
          <div className="space-y-4" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-sm">
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              Waiting for you to finish signing in…
            </p>
            <p className="text-muted-foreground text-sm">
              {phase.tabOpened
                ? "Complete sign-in in the new tab, then come back here."
                : "Your browser blocked the sign-in tab. Open it yourself:"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="lg">
                <a href={phase.browserUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden data-icon="inline-start" />
                  Open sign-in page
                </a>
              </Button>
              <Button variant="ghost" size="lg" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {phase.kind === "failed" && (
              <p role="alert" className="text-destructive text-sm">
                {phase.message}
              </p>
            )}
            <Button
              size="lg"
              className="w-full"
              onClick={() => void start()}
              disabled={phase.kind === "starting"}
            >
              {phase.kind === "starting" && (
                <LoaderCircle aria-hidden data-icon="inline-start" className="animate-spin" />
              )}
              Sign in with Axon
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
