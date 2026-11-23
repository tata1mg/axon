import { StatePanel } from "../ui/StatePanel.tsx";
import type { CatalogView } from "./model.ts";

/** Sign-in, service and load problems. Renders nothing while the catalog is fine. */
export function CatalogStatus({
  view,
  error,
  retry,
}: {
  view?: CatalogView;
  error?: string;
  retry: () => void;
}) {
  const again = (
    <button className="btn" type="button" onClick={retry}>
      Try again
    </button>
  );
  if (error)
    return (
      <StatePanel icon="alert" tone="danger" title="Couldn’t load the catalog" message={error}>
        {again}
      </StatePanel>
    );
  if (view?.status === "signin_required")
    return (
      <StatePanel
        icon="key"
        title="Sign in to see your organization’s catalog"
        hint="Run `axon auth login` in a terminal, then refresh. My MCP servers and My skills work without signing in."
      >
        <button className="btn" type="button" onClick={retry}>
          Refresh
        </button>
      </StatePanel>
    );
  if (view?.status === "unavailable")
    return (
      <StatePanel
        icon="unlink"
        tone="danger"
        title="The catalog isn’t available right now"
        message={view.message}
      >
        {again}
      </StatePanel>
    );
  return null;
}

export function CatalogSkeleton() {
  return (
    <ul className="cat-list" aria-busy="true" aria-label="Loading the catalog">
      {[1, 2, 3].map((key) => (
        <li key={key} className="cat-card skeleton" aria-hidden="true">
          <span className="skeleton-icon" />
          <span className="skeleton-line" />
        </li>
      ))}
    </ul>
  );
}
