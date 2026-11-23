import "./app.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage, type HubSession, isRequestError } from "./api.ts";
import { CatalogProvider } from "./catalog/catalog-context.tsx";
import { DiscoverPage } from "./catalog/DiscoverPage.tsx";
import { HubContext } from "./hub-context.ts";
import { McpPage, McpPageSkeleton } from "./mcp/McpPage.tsx";
import { SkillsPage } from "./skills/SkillsPage.tsx";
import { FeedbackProvider } from "./ui/feedback.tsx";
import { StatePanel } from "./ui/StatePanel.tsx";

const RESTART_HINT = "Run `axon hub` in your terminal and open the new link it prints.";

type Phase =
  | { readonly kind: "connecting" }
  | { readonly kind: "ready"; readonly session: HubSession }
  | {
      readonly kind: "failed";
      readonly title: string;
      readonly message?: string;
      readonly hint: string;
      readonly retry?: boolean;
    };

function failure(error: unknown, hadToken: boolean): Phase {
  if (isRequestError(error) && error.status === 401)
    return hadToken
      ? {
          kind: "failed",
          title: "This link has expired",
          message: "Hub links work once, in one browser, for five minutes.",
          hint: RESTART_HINT,
        }
      : { kind: "failed", title: "Your hub session ended", hint: RESTART_HINT };
  if (isRequestError(error) && error.status === 0)
    return {
      kind: "failed",
      title: "Can’t reach the hub",
      message: errorMessage(error),
      hint: RESTART_HINT,
    };
  return {
    kind: "failed",
    title: "Couldn’t start the hub session",
    message: errorMessage(error),
    hint: "Try again. If it keeps failing, restart `axon hub`.",
    retry: true,
  };
}

type Tab = "mcp" | "skills" | "discover";

/** One "My …" tab per installable kind, then the organization catalog for every kind. */
const TABS: readonly { id: Tab; label: string; feature: string }[] = [
  { id: "mcp", label: "My MCP servers", feature: "localMcps" },
  { id: "skills", label: "My skills", feature: "localSkills" },
  { id: "discover", label: "Discover", feature: "catalog" },
];

/** `launch` starts once at module load so the single-use token is exchanged exactly once. */
export function App({ launch, hadToken }: { launch: Promise<HubSession>; hadToken: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [tab, setTab] = useState<Tab>("mcp");

  useEffect(() => {
    let current = true;
    launch.then(
      (session) => current && setPhase({ kind: "ready", session }),
      (error: unknown) => current && setPhase(failure(error, hadToken)),
    );
    return () => {
      current = false;
    };
  }, [launch, hadToken]);

  const endSession = useCallback(
    () => setPhase({ kind: "failed", title: "Your hub session ended", hint: RESTART_HINT }),
    [],
  );
  const hub = useMemo(
    () => (phase.kind === "ready" ? { session: phase.session, endSession } : null),
    [phase, endSession],
  );

  return (
    <FeedbackProvider>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              a
            </span>
            Axon Hub
          </span>
          {hub && (
            <nav className="app-nav" aria-label="Hub sections">
              {TABS.filter(({ feature }) => hub.session.features[feature] === true).map(
                ({ id, label }) => (
                  <button
                    key={id}
                    className="app-tab"
                    type="button"
                    aria-current={tab === id ? "page" : undefined}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ),
              )}
            </nav>
          )}
          <span
            className="local-pill"
            title="This page only talks to the axon hub process running in your terminal."
          >
            <span className="dot" aria-hidden="true" />
            Local only
          </span>
        </div>
      </header>
      <main className="page">
        {phase.kind === "failed" ? (
          <StatePanel
            icon="unlink"
            tone="danger"
            title={phase.title}
            hint={phase.hint}
            {...(phase.message ? { message: phase.message } : {})}
          >
            {phase.retry && (
              <button className="btn" type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
            )}
          </StatePanel>
        ) : hub ? (
          <HubContext.Provider value={hub}>
            <CatalogProvider>
              {tab === "discover" && hub.session.features["catalog"] ? (
                <DiscoverPage />
              ) : tab === "skills" && hub.session.features["localSkills"] ? (
                <SkillsPage />
              ) : (
                <McpPage />
              )}
            </CatalogProvider>
          </HubContext.Provider>
        ) : (
          <McpPageSkeleton />
        )}
      </main>
    </FeedbackProvider>
  );
}
