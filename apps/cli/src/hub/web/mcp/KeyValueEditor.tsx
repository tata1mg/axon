import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "../ui/Icon.tsx";
import { type KvRow, type KvRules, newRow } from "./model.ts";

interface KeyValueEditorProps {
  readonly rules: KvRules;
  readonly title: string;
  readonly hint: ReactNode;
  readonly addLabel: string;
  readonly rows: readonly KvRow[];
  /** `changedId` is the input that changed, so its error can clear. */
  readonly onChange: (rows: KvRow[], changedId?: string) => void;
  readonly invalidId: string | undefined;
}

export function kvInputId(section: string, row: number, part: "key" | "value" | "undo"): string {
  return `${section}-${row}-${part}`;
}

/**
 * Stored keys arrive without values: a blank value keeps the stored one, a new value replaces it,
 * and Remove deletes the key on save (with Undo until then).
 */
export function KeyValueEditor({
  rules,
  title,
  hint,
  addLabel,
  rows,
  onChange,
  invalidId,
}: KeyValueEditorProps) {
  const { section, noun } = rules;
  const focusNext = useRef<string | null>(null);
  const label = noun === "header" ? "Header" : "Variable";

  // Rows are added and removed by re-rendering, so move focus after the DOM updates.
  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });

  const update = (id: number, patch: Partial<KvRow>, changedId?: string) =>
    onChange(
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      changedId,
    );

  return (
    <section className="field kv" aria-labelledby={`${section}-title`}>
      <div className="kv-head">
        <h3 id={`${section}-title`}>{title}</h3>
        <span className="optional">Optional</span>
      </div>
      <p className="hint">{hint}</p>
      {rows.length > 0 && (
        <div className="kv-rows">
          {rows.map((row) => {
            const keyId = kvInputId(section, row.id, "key");
            const valueId = kvInputId(section, row.id, "value");
            const undoId = kvInputId(section, row.id, "undo");
            const stored = row.stored !== undefined;
            return (
              <div key={row.id} className={row.removed ? "kv-row is-removed" : "kv-row"}>
                <input
                  id={keyId}
                  className="kv-key mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={row.key}
                  readOnly={stored}
                  tabIndex={stored ? -1 : undefined}
                  placeholder={stored ? undefined : noun === "header" ? "Header" : "NAME"}
                  aria-label={stored ? `Stored ${noun}` : `${label} name`}
                  aria-invalid={invalidId === keyId || undefined}
                  onChange={(event) => update(row.id, { key: event.target.value }, keyId)}
                />
                {row.removed ? (
                  <>
                    <span className="kv-removed">Will be removed when you save</span>
                    <button
                      id={undoId}
                      className="btn btn-sm btn-ghost kv-undo"
                      type="button"
                      onClick={() => {
                        focusNext.current = valueId;
                        update(row.id, { removed: false });
                      }}
                    >
                      Undo
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      id={valueId}
                      className="kv-value mono"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={row.value}
                      placeholder={stored ? "Stored value hidden · leave blank to keep" : "Value"}
                      aria-label={stored ? `New value for ${row.stored}` : "Value"}
                      aria-invalid={invalidId === valueId || undefined}
                      onChange={(event) => update(row.id, { value: event.target.value }, valueId)}
                    />
                    <button
                      className="btn btn-icon btn-ghost btn-sm kv-remove"
                      type="button"
                      aria-label={`Remove ${row.stored ?? noun}`}
                      onClick={() => {
                        if (stored) {
                          focusNext.current = undoId;
                          update(row.id, { removed: true });
                        } else {
                          focusNext.current = `${section}-add`;
                          onChange(rows.filter((item) => item.id !== row.id));
                        }
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <button
        id={`${section}-add`}
        className="btn btn-sm btn-ghost kv-add"
        type="button"
        onClick={() => {
          const row = newRow();
          focusNext.current = kvInputId(section, row.id, "key");
          onChange([...rows, row]);
        }}
      >
        <Icon name="plus" />
        {addLabel}
      </button>
    </section>
  );
}
