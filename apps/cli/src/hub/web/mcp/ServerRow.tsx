import { Icon } from "../ui/Icon.tsx";
import { type McpServer, serverFacts, serverState } from "./model.ts";

interface ServerRowProps {
  readonly server: McpServer;
  /** Key of the request in flight, such as `toggle:github`. */
  readonly pending: string | null;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

export function ServerRow({ server, pending, onToggle, onEdit, onRemove }: ServerRowProps) {
  const kind = serverState(server);
  const toggling = pending === `toggle:${server.name}`;
  // Optimistic: the switch flips while the request is in flight.
  const checked = toggling ? !server.enabled : server.enabled;
  const facts = serverFacts(server);
  const target = server.command ?? server.url;
  return (
    <li className="server" data-state={kind}>
      <span className="server-icon">
        <Icon
          name={kind === "invalid" ? "alert" : server.transport === "stdio" ? "terminal" : "globe"}
        />
      </span>
      <div className="server-main">
        <div className="server-head">
          <h2 className="server-name">{server.name}</h2>
          {kind !== "invalid" && (
            <span className="tag">{server.transport === "stdio" ? "Local" : "Remote"}</span>
          )}
          {server.catalog && (
            <span className="tag tag-accent" title={`Catalog revision ${server.catalog.revision}`}>
              From catalog
            </span>
          )}
          {kind === "disabled" && <span className="tag tag-muted">Disabled</span>}
          {kind === "invalid" && <span className="tag tag-warn">Needs repair</span>}
        </div>
        {kind === "invalid" ? (
          <p className="server-desc">
            Not a supported local command or HTTP server. Fix it in the config file, or remove it.
          </p>
        ) : (
          <p className={server.description ? "server-desc" : "server-desc placeholder"}>
            {server.description || "No description"}
          </p>
        )}
        {target ? (
          <code className="server-target">{target}</code>
        ) : (
          server.hasStoredUrl && (
            <p className="server-target private">
              Private URL, not shown (it includes credentials or a query string)
            </p>
          )
        )}
        {facts.length > 0 && (
          <ul className="server-facts">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="server-actions">
        {kind !== "invalid" && (
          <>
            <button
              className={toggling ? "switch is-pending" : "switch"}
              type="button"
              role="switch"
              aria-checked={checked}
              aria-label={`Enable ${server.name}`}
              title={checked ? "Enabled" : "Disabled"}
              onClick={onToggle}
            >
              <span className="switch-thumb" />
            </button>
            <button
              className="btn btn-sm edit"
              type="button"
              aria-label={`Edit ${server.name}`}
              onClick={onEdit}
            >
              Edit
            </button>
          </>
        )}
        <button
          className={
            pending === `remove:${server.name}`
              ? "btn btn-icon btn-ghost btn-sm remove is-pending"
              : "btn btn-icon btn-ghost btn-sm remove"
          }
          type="button"
          aria-label={`Remove ${server.name}`}
          title="Remove"
          onClick={onRemove}
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}
