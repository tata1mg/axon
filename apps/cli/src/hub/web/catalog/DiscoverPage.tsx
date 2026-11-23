import { type ReactNode, useEffect, useState } from "react";
import { useHub } from "../hub-context.ts";
import { useFeedback } from "../ui/feedback.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatePanel } from "../ui/StatePanel.tsx";
import { useCatalog } from "./catalog-context.tsx";
import { InstallDialog } from "./InstallDialog.tsx";
import { cardFor, enabledKinds, type KindFilter, type Section, sections } from "./kinds.ts";
import { type CatalogItem, type CatalogView, type McpItem, TIER_LABELS } from "./model.ts";
import { CatalogSkeleton, CatalogStatus } from "./status.tsx";
import "../mcp/mcp.css";
import "./catalog.css";

function PageHead({ refresh }: { refresh?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>Discover</h1>
        <p className="lede">
          What your organization recommends for Pi. Installing something adds it to your user-level
          config.
        </p>
      </div>
      {refresh}
    </div>
  );
}

function ItemCard({ item, onOpen }: { item: CatalogItem; onOpen: () => void }) {
  const { action, tag } = cardFor(item);
  return (
    <li className="cat-card" data-state={item.local.state}>
      <span className="cat-avatar" aria-hidden="true">
        {item.metadata.name.charAt(0).toUpperCase()}
      </span>
      <div className="cat-main">
        <div className="server-head">
          <h3 className="server-name">{item.metadata.name}</h3>
          {item.tier && <span className="tag">{TIER_LABELS[item.tier]}</span>}
          {tag && <span className={`tag tag-${tag.tone}`}>{tag.label}</span>}
        </div>
        <p className={item.metadata.summary ? "server-desc" : "server-desc placeholder"}>
          {item.metadata.summary || "No description"}
        </p>
        {item.metadata.tags.length > 0 && (
          <ul className="server-facts">
            {item.metadata.tags.map((tagName) => (
              <li key={tagName}>#{tagName}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="server-actions">
        <button
          className={action.primary ? "btn btn-sm btn-primary" : "btn btn-sm"}
          type="button"
          disabled={action.disabled}
          aria-label={`${action.label} ${item.metadata.name}`}
          onClick={onOpen}
        >
          {action.label}
        </button>
      </div>
    </li>
  );
}

function SectionList({
  section,
  titled,
  busy,
  onOpen,
}: {
  section: Section;
  titled: boolean;
  busy: boolean;
  onOpen: (item: CatalogItem) => void;
}) {
  const { info, items } = section;
  const list =
    items.length === 0 ? (
      <StatePanel
        compact
        icon={info.icon}
        title={`No ${info.label.toLowerCase()} yet`}
        message={info.empty}
      />
    ) : (
      <ul className="cat-list" aria-label={`Catalog ${info.label}`} aria-busy={busy}>
        {items.map((item) => (
          <ItemCard key={item.slug} item={item} onOpen={() => onOpen(item)} />
        ))}
      </ul>
    );
  if (!titled) return list;
  return (
    <section className="cat-section" aria-labelledby={`cat-section-${info.kind}`}>
      <h2 className="cat-section-title" id={`cat-section-${info.kind}`}>
        {info.label}
        {info.preview && <span className="tag tag-muted">Preview</span>}
      </h2>
      {list}
    </section>
  );
}

export function DiscoverPage() {
  const { session } = useHub();
  const { view, error, loading, load, replace } = useCatalog();
  const { toast } = useFeedback();
  const [filter, setFilter] = useState<KindFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const kinds = enabledKinds(session.features);

  useEffect(() => {
    if (!view && !error) void load();
  }, [view, error, load]);

  const refresh = (
    <button
      className={loading ? "btn btn-icon is-pending" : "btn btn-icon"}
      type="button"
      aria-label="Refresh the catalog"
      title="Refresh the catalog"
      onClick={() => void load()}
    >
      <Icon name="refresh" />
    </button>
  );

  if (error || (view && view.status !== "ok"))
    return (
      <>
        <PageHead refresh={refresh} />
        <CatalogStatus
          {...(view ? { view } : {})}
          {...(error ? { error } : {})}
          retry={() => void load()}
        />
      </>
    );
  if (view?.status !== "ok")
    return (
      <>
        <PageHead />
        <CatalogSkeleton />
      </>
    );

  const items = view.items.filter((item) => kinds.some(({ kind }) => kind === item.kind));
  const shown = sections(items, kinds, filter);
  const selected = view.items.find(
    (item): item is McpItem => item.kind === "mcp" && item.slug === open,
  );
  const multiple = kinds.length > 1;

  let body: ReactNode;
  if (items.length === 0)
    body = (
      <StatePanel
        icon="plug"
        title="Nothing published yet"
        message="When your admins publish to the catalog, it appears here."
      />
    );
  else
    body = shown.map((section) => (
      <SectionList
        key={section.info.kind}
        section={section}
        titled={multiple}
        busy={loading}
        onOpen={(item) => {
          if (item.kind === "mcp") setOpen(item.slug);
        }}
      />
    ));

  return (
    <>
      <PageHead refresh={refresh} />
      {installed && (
        <div className="banner">
          <Icon name="refresh" />
          <p>
            <strong>Saved to your config.</strong> Run <code>/reload</code> in each running Pi
            session to load it, or start a new session.
          </p>
          <button
            className="btn btn-icon btn-ghost"
            type="button"
            aria-label="Dismiss"
            onClick={() => setInstalled(false)}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      {multiple && items.length > 0 && (
        <div className="toolbar">
          <fieldset className="filters">
            <legend className="sr-only">Show</legend>
            {[
              { id: "all" as const, label: "All", count: items.length },
              ...kinds.map((info) => ({
                id: info.kind,
                label: info.label,
                count: items.filter(({ kind }) => kind === info.kind).length,
              })),
            ].map(({ id, label, count }) => (
              <button
                key={id}
                className="filter"
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label} <span className="count">{count}</span>
              </button>
            ))}
          </fieldset>
        </div>
      )}
      <div className={multiple && items.length > 0 ? "cat-body" : "cat-body cat-body-spaced"}>
        {body}
      </div>
      {view.skipped > 0 && (
        <p className="page-foot cat-skipped">
          {view.skipped === 1 ? "One entry needs" : `${view.skipped} entries need`} a newer axon to
          show. Update axon to see {view.skipped === 1 ? "it" : "them"}.
        </p>
      )}
      {selected && (
        <InstallDialog
          key={`${selected.slug}:${selected.revision}`}
          item={selected}
          configRevision={view.configRevision}
          onInstalled={(next: CatalogView, name) => {
            replace(next);
            setInstalled(true);
            toast(`Saved ${name}`);
          }}
          onStale={() => {
            setOpen(null);
            void load();
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
