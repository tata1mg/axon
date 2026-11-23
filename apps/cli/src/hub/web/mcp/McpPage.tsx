import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, isRequestError } from "../api.ts";
import { useHub } from "../hub-context.ts";
import { useFeedback } from "../ui/feedback.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatePanel } from "../ui/StatePanel.tsx";
import {
  type Filter,
  type McpCatalog,
  type McpServer,
  matchesQuery,
  type ServerState,
  serverState,
} from "./model.ts";
import { type SaveRequest, ServerEditor } from "./ServerEditor.tsx";
import { ServerRow } from "./ServerRow.tsx";
import "./mcp.css";

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "invalid", label: "Needs repair" },
];

const serverPath = (name: string) => `/mcps/${encodeURIComponent(name)}`;
const anyDialogOpen = () => document.querySelector("dialog[open]") !== null;

function PageHead({ children }: { children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>MCP servers</h1>
        <p className="lede">
          Tools Pi can use, from your user-level config. Changes apply after <code>/reload</code> in
          a running Pi session.
        </p>
      </div>
      {children}
    </div>
  );
}

function AddButton({ onClick, disabled }: { onClick?: () => void; disabled?: boolean }) {
  return (
    <button className="btn btn-primary" type="button" disabled={disabled} onClick={onClick}>
      <Icon name="plus" />
      Add server
    </button>
  );
}

function SkeletonList() {
  return (
    <ul className="server-list" aria-busy="true" aria-label="Loading MCP servers">
      {[1, 2, 3].map((key) => (
        <li key={key} className="server skeleton" aria-hidden="true">
          <span className="skeleton-icon" />
          <span className="skeleton-line" />
        </li>
      ))}
    </ul>
  );
}

/** Shown while the browser session is being established. */
export function McpPageSkeleton() {
  return (
    <>
      <PageHead>
        <AddButton disabled />
      </PageHead>
      <SkeletonList />
    </>
  );
}

export function McpPage() {
  const { endSession } = useHub();
  const { toast, confirm } = useFeedback();
  const [catalog, setCatalog] = useState<McpCatalog>();
  const [loadError, setLoadError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [unreloaded, setUnreloaded] = useState(false);
  const [editing, setEditing] = useState<{ server?: McpServer; revision: string } | null>(null);
  const busy = useRef(false);
  const latest = useRef(catalog);
  latest.current = catalog;
  const searchRef = useRef<HTMLInputElement>(null);

  /** Serializes requests: the API is revision-checked, so concurrent writes would conflict anyway. */
  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(key);
    try {
      await task();
      return true;
    } finally {
      busy.current = false;
      setPending(null);
    }
  }, []);

  const load = useCallback(
    async ({ key = "load", announce = false } = {}): Promise<McpCatalog | undefined> => {
      let next: McpCatalog | undefined;
      try {
        const done = await run(key, async () => {
          next = await api<McpCatalog>("/mcps");
          setCatalog(next);
          setLoadError(undefined);
        });
        if (done && announce) toast("Reloaded from disk");
      } catch (error) {
        if (isRequestError(error) && error.status === 401) endSession();
        else if (!latest.current) setLoadError(errorMessage(error));
        else if (announce) toast(errorMessage(error), { tone: "error" });
      }
      return next;
    },
    [run, toast, endSession],
  );

  const fail = useCallback(
    (error: unknown) => {
      if (isRequestError(error) && error.status === 401) {
        endSession();
        return;
      }
      toast(errorMessage(error), {
        tone: "error",
        ...(isRequestError(error) && error.status === 409
          ? {
              action: {
                label: "Refresh",
                run: () => void load({ key: "refresh", announce: true }),
              },
            }
          : {}),
      });
    },
    [endSession, toast, load],
  );

  const mutate = (key: string, request: () => Promise<McpCatalog>) =>
    run(key, async () => {
      setCatalog(await request());
      setUnreloaded(true);
    });

  useEffect(() => {
    void load();
  }, [load]);

  // `/` jumps to search, like most list UIs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (anyDialogOpen() || !searchRef.current) return;
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      event.preventDefault();
      searchRef.current.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Pick up edits made in another editor while this tab was in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !latest.current || anyDialogOpen()) return;
      void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  async function toggle(server: McpServer) {
    if (busy.current) return;
    const enabling = !server.enabled;
    if (
      enabling &&
      server.requiresExecutionApproval &&
      !(await confirm({
        title: `Enable ${server.name}?`,
        body:
          server.transport === "stdio"
            ? `Next time Pi loads its config, it will run “${server.command}” with your permissions. Only enable servers you trust.`
            : "Next time Pi loads its config, this server’s !command credential helpers run with your permissions. Only enable servers you trust.",
        confirmLabel: "Trust and enable",
      }))
    )
      return;
    try {
      const done = await mutate(`toggle:${server.name}`, () =>
        api(serverPath(server.name), "PATCH", {
          revision: latest.current?.revision,
          changes: { enabled: enabling },
          confirmExecution: enabling && server.requiresExecutionApproval,
        }),
      );
      if (done) toast(`${server.name} ${enabling ? "enabled" : "disabled"}`);
    } catch (error) {
      fail(error);
    }
  }

  async function remove(server: McpServer) {
    if (busy.current) return;
    const confirmed = await confirm({
      title: `Remove ${server.name}?`,
      body: "Its entry, including any stored credentials, is deleted from your user-level config file. Installed packages and project-level overrides aren’t touched.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      const done = await mutate(`remove:${server.name}`, () =>
        api(serverPath(server.name), "DELETE", { revision: latest.current?.revision }),
      );
      if (done) toast(`Removed ${server.name}`);
    } catch (error) {
      fail(error);
    }
  }

  async function save(server: McpServer | undefined, request: SaveRequest): Promise<boolean> {
    const { name, fields, confirmExecution, revision } = request;
    const done = await mutate("save", () =>
      server
        ? api(serverPath(server.name), "PATCH", { revision, changes: fields, confirmExecution })
        : api("/mcps", "POST", { revision, name, definition: fields, confirmExecution }),
    );
    if (done) {
      setEditing(null);
      toast(server ? `Saved ${name}` : `Added ${name}`);
    }
    return done;
  }

  const openEditor = (server?: McpServer) => {
    if (busy.current || !catalog) return;
    setEditing(server ? { server, revision: catalog.revision } : { revision: catalog.revision });
  };

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      toast("Path copied");
    } catch {
      toast("Couldn’t copy. Select the path and copy it manually.", { tone: "error" });
    }
  }

  const servers = catalog?.servers ?? [];
  const counts: Record<Filter, number> = {
    all: servers.length,
    enabled: 0,
    disabled: 0,
    invalid: 0,
  };
  for (const server of servers) counts[serverState(server) satisfies ServerState] += 1;
  const activeFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  const visible = servers.filter(
    (server) =>
      (activeFilter === "all" || serverState(server) === activeFilter) &&
      matchesQuery(server, query),
  );

  let body: ReactNode;
  if (loadError)
    body = (
      <StatePanel
        icon="alert"
        tone="danger"
        title="Couldn’t load your MCP config"
        message={loadError}
        hint="Fix the problem, then try again. The hub never rewrites a file it can’t read."
      >
        <button
          className={pending === "load" ? "btn is-pending" : "btn"}
          type="button"
          onClick={() => void load()}
        >
          Try again
        </button>
      </StatePanel>
    );
  else if (!catalog) body = <SkeletonList />;
  else if (servers.length === 0)
    body = (
      <StatePanel
        icon="plug"
        title="No MCP servers yet"
        message="Add a remote server by its URL, or a local one by the command that starts it."
      >
        <button className="btn btn-primary" type="button" onClick={() => openEditor()}>
          <Icon name="plus" />
          Add your first server
        </button>
      </StatePanel>
    );
  else
    body = (
      <section aria-label="Configured servers">
        <div className="toolbar">
          <fieldset className="filters">
            <legend className="sr-only">Show</legend>
            {FILTERS.filter(({ id }) => id !== "invalid" || counts.invalid > 0).map(
              ({ id, label }) => (
                <button
                  key={id}
                  className={id === "invalid" ? "filter filter-warn" : "filter"}
                  type="button"
                  aria-pressed={activeFilter === id}
                  onClick={() => setFilter(id)}
                >
                  {label} <span className="count">{counts[id]}</span>
                </button>
              ),
            )}
          </fieldset>
          <div className="toolbar-end">
            <label className="search">
              <Icon name="search" />
              <input
                ref={searchRef}
                type="search"
                placeholder="Search servers"
                aria-label="Search servers"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    setQuery("");
                  }
                }}
              />
              <span className="kbd" aria-hidden="true">
                /
              </span>
            </label>
            <button
              className={pending === "refresh" ? "btn btn-icon is-pending" : "btn btn-icon"}
              type="button"
              aria-label="Reload from disk"
              title="Reload from disk"
              onClick={() => void load({ key: "refresh", announce: true })}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        {visible.length > 0 ? (
          <ul className="server-list" aria-label="MCP servers" aria-busy={pending !== null}>
            {visible.map((server) => (
              <ServerRow
                key={server.name}
                server={server}
                pending={pending}
                onToggle={() => void toggle(server)}
                onEdit={() => openEditor(server)}
                onRemove={() => void remove(server)}
              />
            ))}
          </ul>
        ) : (
          <StatePanel
            compact
            message={
              query.trim()
                ? `No servers match “${query.trim()}”.`
                : activeFilter === "invalid"
                  ? "No servers need repair."
                  : `No ${activeFilter} servers.`
            }
          >
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Clear search and filters
            </button>
          </StatePanel>
        )}
      </section>
    );

  return (
    <>
      <PageHead>
        {(!catalog || servers.length > 0) && !loadError && (
          <AddButton disabled={!catalog} onClick={() => openEditor()} />
        )}
      </PageHead>

      {unreloaded && (
        <div className="banner">
          <Icon name="refresh" />
          <p>
            <strong>Saved to your config.</strong> Run <code>/reload</code> in each running Pi
            session to apply it, or start a new session.
          </p>
          <button
            className="btn btn-icon btn-ghost"
            type="button"
            aria-label="Dismiss"
            onClick={() => setUnreloaded(false)}
          >
            <Icon name="x" />
          </button>
        </div>
      )}

      {body}

      <footer className="page-foot">
        <div className="config-path">
          <span className="foot-label">Config file</span>
          <code>{catalog?.configPath ?? (loadError ? "Unavailable" : "Connecting…")}</code>
          {catalog && "clipboard" in navigator && (
            <button
              className="btn btn-icon btn-ghost btn-sm"
              type="button"
              aria-label="Copy config file path"
              title="Copy path"
              onClick={() => void copyPath(catalog.configPath)}
            >
              <Icon name="copy" />
            </button>
          )}
        </div>
        <p>
          Stored argument, environment, header, and OAuth values are never sent to this page; it
          only sees key names and counts. Project-level overrides in <code>.pi/mcp.json</code>{" "}
          aren’t shown.
        </p>
      </footer>

      {editing && catalog && (
        <ServerEditor
          key={editing.server?.name ?? "new"}
          {...(editing.server ? { server: editing.server } : {})}
          servers={servers}
          revision={editing.revision}
          saving={pending === "save"}
          onSave={(request) => save(editing.server, request)}
          onConflict={() => load()}
          onNoChanges={() => {
            setEditing(null);
            toast("No changes to save");
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
