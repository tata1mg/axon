import { Check, Copy, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { TierBadge } from "./fields";
import {
  inlineTokens,
  isObject,
  jsonList,
  objectList,
  serverMode,
  serverOf,
  text,
  textEntries,
  textList,
} from "./model";
import type { CatalogKind, Draft, InstallTier, Json, JsonObject } from "./types";

function InlineText({ value }: { value: string }) {
  return (
    <>
      {inlineTokens(value).map((token, index) => {
        const key = `${index}-${token.kind}`;
        if (token.kind === "code")
          return (
            <code key={key} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
              {token.text}
            </code>
          );
        if (token.kind === "bold") return <strong key={key}>{token.text}</strong>;
        if (token.kind === "link")
          return (
            <a
              key={key}
              href={token.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {token.text}
            </a>
          );
        return <span key={key}>{token.text}</span>;
      })}
    </>
  );
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      {label && <p className="text-xs font-medium">{label}</p>}
      <div className="bg-muted flex items-start gap-2 rounded-md p-2">
        <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
          {command}
        </pre>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Copy command"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

function PreviewBlock({
  block,
  inputs,
  prerequisites,
}: {
  block: Json;
  inputs: Map<string, JsonObject>;
  prerequisites: Map<string, JsonObject>;
}) {
  if (!isObject(block)) return null;
  switch (block.type) {
    case "text":
      return (
        <p className="text-sm whitespace-pre-line">
          <InlineText value={text(block.text)} />
        </p>
      );
    case "command":
      return <CopyCommand command={text(block.command)} label={text(block.label)} />;
    case "link": {
      const url = text(block.url);
      return (
        <Button asChild={url.startsWith("https://")} variant="outline" size="sm">
          {url.startsWith("https://") ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {text(block.label) || url}
              <ExternalLink aria-hidden data-icon="inline-end" />
            </a>
          ) : (
            <span>{text(block.label) || "Link"}</span>
          )}
        </Button>
      );
    }
    case "callout": {
      const warning = block.tone === "warning";
      const Icon = warning ? TriangleAlert : Info;
      return (
        <div
          className={cn(
            "flex gap-2 rounded-md border p-2 text-sm",
            warning ? "border-amber-500/40 bg-amber-500/10" : "bg-muted/50",
          )}
        >
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 whitespace-pre-line">
            <InlineText value={text(block.text)} />
          </p>
        </div>
      );
    }
    case "input":
      return <PreviewInput input={inputs.get(text(block.input))} />;
    case "check":
      return <PreviewPrerequisite prerequisite={prerequisites.get(text(block.prerequisite))} />;
    case "confirm":
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox disabled />
          {text(block.label) || "Confirm"}
        </label>
      );
    default:
      return null;
  }
}

function PreviewInput({ input }: { input: JsonObject | undefined }) {
  if (!input)
    return <p className="text-destructive text-xs">This step points to an unknown input.</p>;
  const secret = input.type === "secret";
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">
        {text(input.label) || text(input.id)}
        {input.required === false && <span className="text-muted-foreground"> (optional)</span>}
      </p>
      <Input disabled type={secret ? "password" : "text"} placeholder={text(input.placeholder)} />
      {objectList(input.help).length > 0 && (
        <div className="space-y-2 pt-1">
          {jsonList(input.help).map((block, index) => (
            <PreviewBlock key={index} block={block} inputs={new Map()} prerequisites={new Map()} />
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewPrerequisite({ prerequisite }: { prerequisite: JsonObject | undefined }) {
  if (!prerequisite)
    return <p className="text-destructive text-xs">This step points to an unknown prerequisite.</p>;
  const executable = isObject(prerequisite.detect) ? text(prerequisite.detect.executable) : "";
  return (
    <div className="space-y-2 rounded-md border p-2">
      <p className="text-sm font-medium">{text(prerequisite.label) || text(prerequisite.id)}</p>
      <p className="text-muted-foreground text-xs">
        {executable ? (
          <>
            The hub checks for <code className="font-mono">{executable}</code> on the user&apos;s
            PATH.
          </>
        ) : (
          "Not detected automatically."
        )}
      </p>
      {jsonList(prerequisite.help).map((block, index) => (
        <PreviewBlock key={index} block={block} inputs={new Map()} prerequisites={new Map()} />
      ))}
    </div>
  );
}

/** How a template value will look once the hub fills it in: inputs become "your …". */
function shown(value: string, inputs: Map<string, JsonObject>): string {
  return value.replace(/\$\{input:([^}]*)\}/g, (_match, id: string) => {
    const input = inputs.get(id);
    if (input?.type === "secret") return "••••••";
    return `‹${text(input?.label) || id}›`;
  });
}

function Review({ draft, inputs }: { draft: Draft; inputs: Map<string, JsonObject> }) {
  const server = serverOf(draft);
  if (!server) return null;
  const mode = serverMode(draft);
  const rows: [string, string][] = [];
  if (mode === "stdio") {
    rows.push(["Runs", shown([text(server.command), ...textList(server.args)].join(" "), inputs)]);
    for (const [name, value] of textEntries(server.env))
      rows.push([`env ${name}`, shown(value, inputs)]);
    if (server.cwd) rows.push(["Working directory", shown(text(server.cwd), inputs)]);
  } else {
    rows.push(["URL", shown(text(server.url), inputs)]);
    for (const [name, value] of textEntries(server.headers))
      rows.push([`header ${name}`, shown(value, inputs)]);
  }
  rows.push(["Exposure", text(server.exposure) || "codemode"]);
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Review before installing</p>
      <dl className="bg-muted/40 grid gap-x-3 gap-y-1 rounded-md p-2 text-xs sm:grid-cols-[max-content_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 font-mono break-all">{value || "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function CatalogPreview({
  kind,
  draft,
  tier,
}: {
  kind: CatalogKind;
  draft: Draft;
  tier: InstallTier | null;
}) {
  const name = text(draft.metadata.name) || "Untitled";
  const tags = textList(draft.metadata.tags);
  const inputs = new Map(objectList(draft.spec.inputs).map((input) => [text(input.id), input]));
  const prerequisites = new Map(
    objectList(draft.spec.prerequisites).map((prerequisite) => [
      text(prerequisite.id),
      prerequisite,
    ]),
  );
  const steps = jsonList(draft.spec.steps);
  const placed = new Set(
    steps
      .filter(isObject)
      .filter((block) => block.type === "input")
      .map((block) => text(block.input)),
  );
  const checked = new Set(
    steps
      .filter(isObject)
      .filter((block) => block.type === "check")
      .map((block) => text(block.prerequisite)),
  );
  const mode = serverMode(draft);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-lg border p-3">
        <span
          aria-hidden
          className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold"
        >
          {name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{name}</span>
            {kind === "skill" ? (
              <Badge variant="secondary">Coming soon</Badge>
            ) : (
              <TierBadge tier={tier} />
            )}
          </div>
          {text(draft.metadata.summary) && (
            <p className="text-muted-foreground text-sm">{text(draft.metadata.summary)}</p>
          )}
          {tags.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {tags.map((tag) => `#${tag}`).join("  ")}
            </p>
          )}
        </div>
      </div>

      {kind === "skill" ? (
        <p className="text-muted-foreground text-xs">
          Skills are a preview. Developers see this card in the hub, with Install disabled.
        </p>
      ) : (
        <div className="space-y-3">
          {[...prerequisites.values()]
            .filter((prerequisite) => !checked.has(text(prerequisite.id)))
            .map((prerequisite) => (
              <PreviewPrerequisite key={text(prerequisite.id)} prerequisite={prerequisite} />
            ))}
          {steps.map((block, index) => (
            <PreviewBlock key={index} block={block} inputs={inputs} prerequisites={prerequisites} />
          ))}
          {[...inputs.values()]
            .filter((input) => !placed.has(text(input.id)))
            .map((input) => (
              <PreviewInput key={text(input.id)} input={input} />
            ))}
          <Review draft={draft} inputs={inputs} />
          <Button type="button" size="lg" disabled className="w-full">
            {mode === "none"
              ? "Instructions only"
              : mode === "stdio"
                ? "Trust and install"
                : "Install"}
          </Button>
          {jsonList(draft.spec.afterInstall).length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium">After install</p>
              {jsonList(draft.spec.afterInstall).map((block, index) => (
                <PreviewBlock
                  key={index}
                  block={block}
                  inputs={inputs}
                  prerequisites={prerequisites}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
