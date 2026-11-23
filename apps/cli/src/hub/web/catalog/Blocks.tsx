import { useState } from "react";
import { Icon } from "../ui/Icon.tsx";
import {
  type CatalogInput,
  type HelpBlock,
  inlineTokens,
  type Prerequisite,
  type StepBlock,
  safeHref,
} from "./model.ts";

/** Catalog text: `code`, **bold** and https links only. Never parsed as HTML. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {inlineTokens(text).map((token, index) => {
        // Index keys are stable: the tokens come from one string, in order.
        const key = `${index}-${token.kind}`;
        if (token.kind === "code") return <code key={key}>{token.text}</code>;
        if (token.kind === "bold") return <strong key={key}>{token.text}</strong>;
        if (token.kind === "link")
          return (
            <a key={key} href={token.href} target="_blank" rel="noopener noreferrer">
              {token.text}
            </a>
          );
        return <span key={key}>{token.text}</span>;
      })}
    </>
  );
}

function CommandBlock({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cat-command">
      {label && <p className="cat-command-label">{label}</p>}
      <div className="cat-command-box">
        <pre>{command}</pre>
        {"clipboard" in navigator && (
          <button
            className="btn btn-icon btn-ghost btn-sm"
            type="button"
            aria-label={copied ? "Copied" : "Copy command"}
            title={copied ? "Copied" : "Copy"}
            onClick={() => {
              navigator.clipboard.writeText(command).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
        )}
      </div>
    </div>
  );
}

export function HelpBlockView({ block }: { block: HelpBlock }) {
  switch (block.type) {
    case "text":
      return (
        <p className="cat-text">
          <InlineText text={block.text} />
        </p>
      );
    case "command":
      return (
        <CommandBlock command={block.command} {...(block.label ? { label: block.label } : {})} />
      );
    case "link": {
      const href = safeHref(block.url);
      if (!href) return null;
      return (
        <a className="btn btn-sm cat-link" href={href} target="_blank" rel="noopener noreferrer">
          {block.label}
          <Icon name="external" />
        </a>
      );
    }
    case "callout":
      return (
        <div className={block.tone === "warning" ? "cat-callout warn" : "cat-callout"}>
          <Icon name={block.tone === "warning" ? "alert" : "info"} />
          <p>
            <InlineText text={block.text} />
          </p>
        </div>
      );
  }
}

export function HelpBlocks({ blocks }: { blocks: readonly HelpBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="cat-blocks">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one revision's blocks, rendered in their fixed order.
        <HelpBlockView key={`${index}-${block.type}`} block={block} />
      ))}
    </div>
  );
}

export function InputField({
  input,
  value,
  updating,
  onChange,
}: {
  input: CatalogInput;
  value: string;
  updating: boolean;
  onChange: (value: string) => void;
}) {
  const id = `input-${input.id}`;
  const keepHint = updating ? "Leave blank to keep the value you entered before." : undefined;
  return (
    <div className="field cat-input">
      <label htmlFor={id}>
        {input.label}
        {!input.required && <span className="optional">Optional</span>}
      </label>
      <input
        id={id}
        type={input.type === "secret" ? "password" : input.type === "url" ? "url" : "text"}
        className={input.type === "secret" || input.type === "path" ? "mono" : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={input.placeholder ?? (updating ? "Unchanged" : "")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {input.type === "secret" && (
        <p className="hint">Saved only in your mcp.json on this machine. {keepHint}</p>
      )}
      {input.type !== "secret" && keepHint && <p className="hint">{keepHint}</p>}
      <HelpBlocks blocks={input.help} />
    </div>
  );
}

export function PrerequisiteRow({
  prerequisite,
  status,
}: {
  prerequisite: Prerequisite;
  status: { readonly found: boolean; readonly path?: string } | undefined;
}) {
  const detected = prerequisite.detect !== undefined;
  const found = detected && status?.found === true;
  return (
    <div className={found ? "cat-prereq found" : detected ? "cat-prereq missing" : "cat-prereq"}>
      <div className="cat-prereq-head">
        <Icon name={found ? "check" : detected ? "alert" : "info"} />
        <strong>{prerequisite.label}</strong>
        {detected && (
          <span className={found ? "tag tag-ok" : "tag tag-warn"}>
            {found ? "Found" : "Not found"}
          </span>
        )}
      </div>
      {found && status?.path && <code className="cat-prereq-path">{status.path}</code>}
      {detected && !found && (
        <p className="hint">
          <code>{prerequisite.detect?.executable}</code> isn’t on your PATH. Install it, then
          refresh.
        </p>
      )}
      {!found && <HelpBlocks blocks={prerequisite.help} />}
    </div>
  );
}

export type StepContext = {
  readonly inputs: ReadonlyMap<string, CatalogInput>;
  readonly prerequisites: ReadonlyMap<string, Prerequisite>;
  readonly status: ReadonlyMap<string, { readonly found: boolean; readonly path?: string }>;
  readonly values: Readonly<Record<string, string>>;
  readonly confirmed: ReadonlySet<string>;
  readonly updating: boolean;
  readonly setValue: (id: string, value: string) => void;
  readonly setConfirmed: (id: string, checked: boolean) => void;
};

export function StepView({ block, context }: { block: StepBlock; context: StepContext }) {
  if (block.type === "input") {
    const input = context.inputs.get(block.input);
    if (!input) return null;
    return (
      <InputField
        input={input}
        value={context.values[input.id] ?? ""}
        updating={context.updating}
        onChange={(value) => context.setValue(input.id, value)}
      />
    );
  }
  if (block.type === "check") {
    const prerequisite = context.prerequisites.get(block.prerequisite);
    if (!prerequisite) return null;
    return (
      <PrerequisiteRow prerequisite={prerequisite} status={context.status.get(prerequisite.id)} />
    );
  }
  if (block.type === "confirm") {
    const id = `confirm-${block.id}`;
    return (
      <label className="cat-confirm" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={context.confirmed.has(block.id)}
          onChange={(event) => context.setConfirmed(block.id, event.target.checked)}
        />
        {block.label}
      </label>
    );
  }
  return <HelpBlockView block={block} />;
}
