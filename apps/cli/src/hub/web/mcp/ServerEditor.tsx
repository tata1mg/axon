import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage, isRequestError } from "../api.ts";
import { useHub } from "../hub-context.ts";
import { useFeedback } from "../ui/feedback.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { RichText } from "../ui/RichText.tsx";
import { KeyValueEditor, kvInputId } from "./KeyValueEditor.tsx";
import {
  buildChanges,
  type Changes,
  type CommandRead,
  type EditorForm,
  ENV_RULES,
  EXPOSURES,
  FieldError,
  type FieldTarget,
  HEADER_RULES,
  initialForm,
  isExposure,
  type KvRow,
  type KvSection,
  type McpCatalog,
  type McpServer,
  needsTrust,
  plural,
  readCommand,
  type Transport,
  trustMessage,
  visibleSections,
} from "./model.ts";

export interface SaveRequest {
  readonly name: string;
  readonly fields: Changes;
  readonly confirmExecution: boolean;
  readonly revision: string;
}

interface ServerEditorProps {
  /** Omitted when adding a server. */
  readonly server?: McpServer;
  readonly servers: readonly McpServer[];
  readonly revision: string;
  readonly saving: boolean;
  /** Resolves false when another request is running; rejects with the API error. */
  readonly onSave: (request: SaveRequest) => Promise<boolean>;
  /** Reloads the catalog after a stale-revision conflict. */
  readonly onConflict: () => Promise<McpCatalog | undefined>;
  readonly onNoChanges: () => void;
  readonly onClose: () => void;
}

/** Errors for these inputs appear in their hint; the rest use the alert at the top. */
const INLINE_FIELDS = new Set(["server-name", "server-url", "server-command"]);

function targetId(target: FieldTarget): string {
  return "field" in target
    ? `server-${target.field}`
    : kvInputId(target.kv, target.row, target.part);
}

export function ServerEditor({
  server,
  servers,
  revision: initialRevision,
  saving,
  onSave,
  onConflict,
  onNoChanges,
  onClose,
}: ServerEditorProps) {
  const { endSession } = useHub();
  const { confirm } = useFeedback();
  const [form, setForm] = useState<EditorForm>(() => initialForm(server));
  const [revision, setRevision] = useState(initialRevision);
  const [dirty, setDirty] = useState(false);
  const [fieldError, setFieldError] = useState<{ id: string; message: string } | null>(null);
  const [formError, setFormError] = useState<string>();
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(server && server.exposure !== "codemode"),
  );
  const focusNext = useRef<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });
  useEffect(() => {
    if (formError) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [formError]);

  const update = (patch: Partial<EditorForm>, changedId?: string) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
    if (changedId && fieldError?.id === changedId) {
      setFieldError(null);
      if (!INLINE_FIELDS.has(changedId)) setFormError(undefined);
    }
  };
  const updateRows = (section: KvSection) => (rows: KvRow[], changedId?: string) =>
    update(section === "env" ? { env: rows } : { headers: rows }, changedId);

  const stdio = form.transport === "stdio";
  const command = stdio ? readCommand(form.command, server, form.clearArgs) : undefined;
  const liveCommandError = form.command.trim() && command?.error ? command.error : undefined;
  const sections = visibleSections(form);
  const trust = needsTrust(form, server);
  const privateUrl = Boolean(server?.hasStoredUrl && !server.url);
  const inlineError = (id: string) => (fieldError?.id === id ? fieldError.message : undefined);

  async function requestClose() {
    if (saving) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard your changes?",
        body: server
          ? `Your edits to ${server.name} haven’t been saved.`
          : "This server hasn’t been added yet.",
        confirmLabel: "Discard",
        tone: "danger",
      }))
    )
      return;
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setFormError(undefined);
    let fields: Changes;
    try {
      fields = buildChanges(form, server, servers);
    } catch (error) {
      if (!(error instanceof FieldError)) {
        setFormError(errorMessage(error));
        return;
      }
      const id = targetId(error.target);
      setFieldError({ id, message: error.message });
      if (!INLINE_FIELDS.has(id)) setFormError(error.message);
      focusNext.current = id;
      return;
    }
    if (server && Object.keys(fields).length === 0) {
      onNoChanges();
      return;
    }
    try {
      await onSave({
        name: server?.name ?? form.name.trim(),
        fields,
        confirmExecution: trust,
        revision,
      });
    } catch (error) {
      if (isRequestError(error) && error.status === 401) {
        endSession();
        return;
      }
      if (isRequestError(error) && error.status === 409) {
        const latest = await onConflict();
        if (latest) setRevision(latest.revision);
        setFormError(
          "The config file changed outside the hub, so nothing was saved. The list behind this form is up to date now; check your changes and save again.",
        );
        return;
      }
      setFormError(errorMessage(error));
    }
  }

  const nameError = inlineError("server-name");
  const urlError = inlineError("server-url");
  const commandError = inlineError("server-command") ?? liveCommandError;

  return (
    <Modal
      labelledBy="editor-title"
      onDismiss={requestClose}
      initialFocus={server ? (stdio ? "server-command" : "server-url") : "server-name"}
    >
      <form autoComplete="off" noValidate onSubmit={submit}>
        <header className="modal-head">
          <h2 id="editor-title">{server ? `Edit ${server.name}` : "Add MCP server"}</h2>
          <button
            className="btn btn-icon btn-ghost"
            type="button"
            aria-label="Close"
            onClick={requestClose}
          >
            <Icon name="x" />
          </button>
        </header>

        <div className="modal-body">
          {formError && (
            <div ref={alertRef} className="alert alert-error" role="alert">
              {formError}
            </div>
          )}

          {!server && (
            <fieldset className="field">
              <legend>Type</legend>
              <div className="choice-grid">
                <TransportChoice
                  value="http"
                  current={form.transport}
                  icon="globe"
                  title="Remote"
                  detail="Connect to an HTTP URL"
                  onSelect={(transport) => update({ transport })}
                />
                <TransportChoice
                  value="stdio"
                  current={form.transport}
                  icon="terminal"
                  title="Local"
                  detail="Run a command on this machine"
                  onSelect={(transport) => update({ transport })}
                />
              </div>
            </fieldset>
          )}

          {!server && (
            <div className="field">
              <label htmlFor="server-name">Name</label>
              <input
                id="server-name"
                maxLength={128}
                placeholder="github"
                spellCheck={false}
                value={form.name}
                aria-describedby="name-hint"
                aria-invalid={Boolean(nameError) || undefined}
                onChange={(event) => update({ name: event.target.value }, "server-name")}
              />
              <Hint id="name-hint" error={nameError}>
                How Pi refers to this server. Letters, numbers, hyphens, and underscores.
              </Hint>
            </div>
          )}

          {stdio ? (
            <div className="field">
              <label htmlFor="server-command">Command</label>
              <input
                id="server-command"
                className="mono"
                placeholder="npx -y @modelcontextprotocol/server-everything"
                spellCheck={false}
                value={form.command}
                aria-describedby="command-hint"
                aria-invalid={Boolean(commandError) || undefined}
                onChange={(event) => update({ command: event.target.value }, "server-command")}
              />
              <Hint id="command-hint" error={commandError}>
                {server
                  ? "Change the executable, or paste a full command to replace its arguments. Runs without a shell."
                  : "Paste the command from the server’s docs. It runs directly, without a shell."}
              </Hint>
              {command && !liveCommandError && (
                <CommandPreview
                  command={command}
                  storedArgs={server?.argumentCount ?? 0}
                  clearArgs={form.clearArgs}
                  onToggleClear={() => update({ clearArgs: !form.clearArgs })}
                />
              )}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="server-url">Server URL</label>
              <input
                id="server-url"
                className="mono"
                type="url"
                inputMode="url"
                placeholder={
                  privateUrl ? "Leave blank to keep the stored URL" : "https://example.com/mcp"
                }
                spellCheck={false}
                value={form.url}
                aria-describedby="url-hint"
                aria-invalid={Boolean(urlError) || undefined}
                onChange={(event) => update({ url: event.target.value }, "server-url")}
              />
              <Hint id="url-hint" error={urlError}>
                {privateUrl
                  ? "A private URL is stored (it includes credentials, a query string, or a fragment) and isn’t shown. Leave blank to keep it."
                  : "A streamable HTTP endpoint. Legacy SSE endpoints aren’t supported."}
              </Hint>
            </div>
          )}

          <div className="field">
            <label htmlFor="server-description">
              Description <span className="optional">Optional</span>
            </label>
            <input
              id="server-description"
              maxLength={2048}
              placeholder="What Pi can do with this server"
              value={form.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>

          {sections.env && (
            <KeyValueEditor
              rules={ENV_RULES}
              title="Environment variables"
              hint={
                <RichText text="Write `${NAME}` to read a value from your shell instead of pasting a secret here." />
              }
              addLabel="Add variable"
              rows={form.env}
              onChange={updateRows("env")}
              invalidId={fieldError?.id}
            />
          )}
          {sections.headers && (
            <KeyValueEditor
              rules={HEADER_RULES}
              title="Headers"
              hint={<RichText text="For example `Authorization` = `Bearer ${MY_TOKEN}`." />}
              addLabel="Add header"
              rows={form.headers}
              onChange={updateRows("headers")}
              invalidId={fieldError?.id}
            />
          )}

          <details
            className="advanced"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>Advanced</summary>
            <div className="field">
              <label htmlFor="server-exposure">Tool exposure</label>
              <select
                id="server-exposure"
                value={form.exposure}
                aria-describedby="exposure-hint"
                onChange={(event) => {
                  const exposure = event.target.value;
                  if (isExposure(exposure)) update({ exposure });
                }}
              >
                <option value="codemode">Code mode (default)</option>
                <option value="deferred">Tool search</option>
                <option value="direct">Direct</option>
                <option value="hidden">Hidden</option>
              </select>
              <p className="hint" id="exposure-hint">
                {EXPOSURES[form.exposure].description}
              </p>
            </div>
            {stdio && (
              <div className="field">
                <label htmlFor="server-cwd">
                  Working directory <span className="optional">Optional</span>
                </label>
                <input
                  id="server-cwd"
                  className="mono"
                  spellCheck={false}
                  placeholder={server ? "Leave blank to keep" : "Optional"}
                  value={form.cwd}
                  aria-describedby="cwd-hint"
                  onChange={(event) => update({ cwd: event.target.value })}
                />
                <p className="hint" id="cwd-hint">
                  {server
                    ? "A stored directory isn’t shown. Leave blank to keep it."
                    : "Where the command starts. Leave blank for the default."}
                </p>
              </div>
            )}
            <p className="hint">
              OAuth, timeouts, and per-tool settings already in the file are kept as they are.
            </p>
          </details>

          {!server && (
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
              <span>Enable this server</span>
            </label>
          )}
        </div>

        <footer className="modal-foot modal-foot-stacked">
          {trust && (
            <div className="trust-note">
              <Icon name="shield" />
              <p>
                <RichText text={trustMessage(form, server)} />
              </p>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn" type="button" onClick={requestClose}>
              Cancel
            </button>
            <button
              id="save-server"
              className={saving ? "btn btn-primary is-pending" : "btn btn-primary"}
              type="submit"
              aria-busy={saving || undefined}
            >
              {trust ? "Trust and save" : server ? "Save changes" : "Add server"}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}

function Hint({
  id,
  error,
  children,
}: {
  id: string;
  error: string | undefined;
  children: string;
}) {
  return (
    <p className={error ? "hint is-error" : "hint"} id={id}>
      {error ?? children}
    </p>
  );
}

function TransportChoice({
  value,
  current,
  icon,
  title,
  detail,
  onSelect,
}: {
  value: Transport;
  current: Transport;
  icon: "globe" | "terminal";
  title: string;
  detail: string;
  onSelect: (value: Transport) => void;
}) {
  return (
    <label className="choice">
      <input
        type="radio"
        name="transport"
        value={value}
        checked={current === value}
        onChange={() => onSelect(value)}
      />
      <span className="choice-card">
        <Icon name={icon} className="choice-icon" />
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function CommandPreview({
  command,
  storedArgs,
  clearArgs,
  onToggleClear,
}: {
  command: CommandRead;
  storedArgs: number;
  clearArgs: boolean;
  onToggleClear: () => void;
}) {
  if (command.error || command.tokens.length === 0) return null;
  const note = command.keptArgs
    ? `+ ${plural(command.keptArgs, "hidden stored argument")}`
    : command.replacedArgs
      ? `replaces ${plural(command.replacedArgs, "stored argument")}`
      : clearArgs && storedArgs
        ? `${plural(storedArgs, "stored argument")} cleared`
        : undefined;
  const canClear = storedArgs > 0 && !command.replacedArgs && command.tokens.length === 1;
  return (
    <div id="command-preview" className="token-preview">
      {command.tokens.map((token, index) => (
        // Tokens can repeat, and their order is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <span key={index} className={index === 0 ? "token token-command" : "token"}>
          {token}
        </span>
      ))}
      {note && <span className="token-note">{note}</span>}
      {canClear && (
        <button className="link-button" type="button" onClick={onToggleClear}>
          {clearArgs ? "Undo" : "Clear"}
        </button>
      )}
    </div>
  );
}
