import { type FormEvent, useState } from "react";
import { api, errorMessage, isRequestError } from "../api.ts";
import { useHub } from "../hub-context.ts";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { RichText } from "../ui/RichText.tsx";
import { HelpBlocks, InputField, PrerequisiteRow, type StepContext, StepView } from "./Blocks.tsx";
import {
  blocker,
  type CatalogView,
  isUpdate,
  type McpItem,
  needsTrust,
  reviewRows,
  TIER_LABELS,
  unplacedInputs,
  unplacedPrerequisites,
} from "./model.ts";

interface InstallDialogProps {
  readonly item: McpItem;
  readonly configRevision: string;
  readonly onInstalled: (view: CatalogView, name: string) => void;
  readonly onStale: () => void;
  readonly onClose: () => void;
}

/**
 * Setup steps, inputs, a review of exactly what gets written, then Install. The hub
 * renders the entry from its own copy; this sends only the slug, the revision shown
 * here, and what the user typed.
 */
export function InstallDialog({
  item,
  configRevision,
  onInstalled,
  onStale,
  onClose,
}: InstallDialogProps) {
  const { endSession } = useHub();
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState(`${item.slug}-catalog`);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean }>();
  const [installedAs, setInstalledAs] = useState<string>();

  const server = item.spec.server;
  const updating = isUpdate(item);
  // An installed entry opens as details: where it is, and what to do after installing.
  const details = item.local.state === "installed" && installedAs === undefined;
  const trust = needsTrust(item);
  const reason = blocker(item, { values, confirmed, name });
  const context: StepContext = {
    inputs: new Map(item.spec.inputs.map((input) => [input.id, input])),
    prerequisites: new Map(item.spec.prerequisites.map((entry) => [entry.id, entry])),
    status: new Map(item.prerequisiteStatus.map((entry) => [entry.id, entry])),
    values,
    confirmed,
    updating,
    setValue: (id, value) => setValues((current) => ({ ...current, [id]: value })),
    setConfirmed: (id, checked) =>
      setConfirmed((current) => {
        const next = new Set(current);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      }),
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || reason || !server) return;
    setPending(true);
    setError(undefined);
    const target = item.local.state === "name_in_use" ? name : undefined;
    try {
      const view = await api<CatalogView>("/catalog/install", "POST", {
        kind: "mcp",
        slug: item.slug,
        revision: item.revision,
        configRevision,
        ...(target ? { name: target } : {}),
        // Blank values are left out: on an update they keep what's stored.
        inputs: Object.fromEntries(
          Object.entries(values).filter(([, value]) => value.trim() !== ""),
        ),
        confirmExecution: trust,
      });
      const installed =
        view.status === "ok" ? view.items.find((entry) => entry.slug === item.slug) : undefined;
      const finalName =
        installed?.kind === "mcp" && "name" in installed.local
          ? installed.local.name
          : (target ?? item.slug);
      setInstalledAs(finalName);
      onInstalled(view, finalName);
    } catch (failure) {
      if (isRequestError(failure) && failure.status === 401) {
        endSession();
        return;
      }
      setError({
        message: errorMessage(failure),
        stale: isRequestError(failure) && failure.status === 409,
      });
    } finally {
      setPending(false);
    }
  }

  const title = installedAs
    ? `${item.metadata.name} is ${updating ? "updated" : "installed"}`
    : updating
      ? `Update ${item.metadata.name}`
      : item.metadata.name;

  return (
    <Modal labelledBy="install-title" onDismiss={onClose}>
      <form autoComplete="off" noValidate onSubmit={submit}>
        <header className="modal-head">
          <h2 id="install-title">
            {title}
            {!installedAs && item.tier && <span className="tag">{TIER_LABELS[item.tier]}</span>}
          </h2>
          <button
            className="btn btn-icon btn-ghost"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>

        {details && item.local.state === "installed" ? (
          <div className="modal-body cat-dialog">
            {item.metadata.summary && <p className="cat-summary">{item.metadata.summary}</p>}
            <div className="cat-success">
              <Icon name="check" />
              <p>
                Installed as <code>{item.local.name}</code> from revision{" "}
                {item.local.installedRevision}, the latest. Manage it under My MCP servers.
              </p>
            </div>
            <HelpBlocks blocks={item.spec.afterInstall} />
          </div>
        ) : installedAs ? (
          <div className="modal-body cat-dialog">
            <div className="cat-success">
              <Icon name="check" />
              <p>
                Saved as <code>{installedAs}</code> in your user-level MCP config. Run{" "}
                <code>/reload</code> in each running Pi session to load it, or start a new session.
              </p>
            </div>
            <HelpBlocks blocks={item.spec.afterInstall} />
          </div>
        ) : (
          <div className="modal-body cat-dialog">
            {error && (
              <div className="alert alert-error" role="alert">
                <p>{error.message}</p>
                {error.stale && (
                  <button className="btn btn-sm" type="button" onClick={onStale}>
                    Refresh catalog
                  </button>
                )}
              </div>
            )}
            {item.metadata.summary && <p className="cat-summary">{item.metadata.summary}</p>}
            {item.metadata.docsUrl && (
              <p className="cat-docs">
                <a href={item.metadata.docsUrl} target="_blank" rel="noopener noreferrer">
                  Documentation
                </a>
              </p>
            )}
            {item.local.state === "update_available" && (
              <p className="cat-note">
                You have revision {item.local.installedRevision}; the catalog has revision{" "}
                {item.revision}.
              </p>
            )}
            {"changedLocally" in item.local && item.local.changedLocally && (
              <div className="alert alert-warn">
                <Icon name="alert" className="alert-icon" />
                <div>
                  <strong>You changed this server’s settings</strong>
                  <p>
                    {updating ? "Updating" : "Resetting"} replaces the fields the catalog manages.
                    Fields you added yourself, and whether it’s enabled, stay as they are.
                  </p>
                </div>
              </div>
            )}

            {unplacedPrerequisites(item).map((prerequisite) => (
              <PrerequisiteRow
                key={prerequisite.id}
                prerequisite={prerequisite}
                status={context.status.get(prerequisite.id)}
              />
            ))}
            <div className="cat-steps">
              {item.spec.steps.map((block, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: one revision's blocks, rendered in their fixed order.
                <StepView key={`${index}-${block.type}`} block={block} context={context} />
              ))}
            </div>
            {unplacedInputs(item).map((input) => (
              <InputField
                key={input.id}
                input={input}
                value={values[input.id] ?? ""}
                updating={updating}
                onChange={(value) => context.setValue(input.id, value)}
              />
            ))}

            {item.local.state === "name_in_use" && (
              <div className="field">
                <label htmlFor="install-name">Server name</label>
                <input
                  id="install-name"
                  className="mono"
                  value={name}
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="hint">
                  You already have a server named <code>{item.local.name}</code> that didn’t come
                  from the catalog. It stays as it is.
                </p>
              </div>
            )}

            {server && (
              <section className="cat-review" aria-label="What will be saved">
                <h3>Review</h3>
                <dl>
                  {reviewRows(item, values).map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        )}

        <footer className="modal-foot modal-foot-stacked">
          {!installedAs && !details && server && trust && (
            <div className="trust-note">
              <Icon name="shield" />
              <p>
                <RichText
                  text={`When Pi loads its config, it runs \`${server.command}\` with your permissions. Install only servers you trust.`}
                />
              </p>
            </div>
          )}
          {!installedAs && !details && reason && server && (
            <p className="hint cat-blocker">{reason}</p>
          )}
          <div className="modal-actions">
            {installedAs || details || !server ? (
              <button className="btn btn-primary" type="button" onClick={onClose}>
                Done
              </button>
            ) : (
              <>
                <button className="btn" type="button" onClick={onClose}>
                  Cancel
                </button>
                <button
                  className={pending ? "btn btn-primary is-pending" : "btn btn-primary"}
                  type="submit"
                  disabled={reason !== null}
                  aria-busy={pending || undefined}
                >
                  <Icon name="download" />
                  {trust ? "Trust and " : ""}
                  {updating ? (trust ? "update" : "Update") : trust ? "install" : "Install"}
                </button>
              </>
            )}
          </div>
        </footer>
      </form>
    </Modal>
  );
}
