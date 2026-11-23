import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import { Code } from "./fields";
import { applyImport, importServer, parseSnippet, serverOf, text } from "./model";
import type { Draft } from "./types";

const EXAMPLE = `"redash": {
  "command": "npx",
  "args": ["-y", "@suthio/redash-mcp"],
  "env": { "REDASH_API_KEY": "your-api-key", "REDASH_URL": "https://redash.1mg.com/" }
}`;

const IGNORED_REASONS: Record<string, string> = {
  enabled: "catalog installs are always enabled",
  disabled: "catalog installs are always enabled",
  oauth: "not supported in the catalog yet",
};

export function ImportDialog({
  open,
  onOpenChange,
  current,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Draft;
  onApply: (draft: Draft, slug: string) => void;
}) {
  const [source, setSource] = useState("");
  const [choice, setChoice] = useState(0);
  // Findings start checked; this records the ones the admin unticked.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [skipAuthStep, setSkipAuthStep] = useState(false);

  const parsed = useMemo(() => (source.trim() ? parseSnippet(source) : null), [source]);
  const servers = parsed?.ok ? parsed.servers : [];
  const selected = servers[Math.min(choice, servers.length - 1)];
  const result = useMemo(
    () => (selected ? importServer(selected, current) : null),
    [selected, current],
  );
  const server = serverOf(current);
  const replacesServer = Boolean(server && (text(server.command) || text(server.url)));

  function close(next: boolean) {
    if (!next) {
      setSource("");
      setChoice(0);
      setUnchecked(new Set());
      setSkipAuthStep(false);
    }
    onOpenChange(next);
  }

  function apply() {
    if (!result) return;
    const convert = new Set(
      result.findings.map((finding) => finding.key).filter((key) => !unchecked.has(key)),
    );
    onApply(applyImport(result, convert, result.suggestAuthStep && !skipAuthStep), result.slug);
    close(false);
  }

  function toggle(key: string, checked: boolean) {
    const next = new Set(unchecked);
    if (checked) next.delete(key);
    else next.add(key);
    setUnchecked(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from mcp.json</DialogTitle>
          <DialogDescription>
            Paste a server entry or a whole <Code>mcp.json</Code> file. This fills in the server
            settings; you review everything before saving.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          aria-label="mcp.json snippet"
          value={source}
          placeholder={EXAMPLE}
          spellCheck={false}
          className="min-h-40 font-mono"
          onChange={(event) => setSource(event.target.value)}
        />

        {parsed && !parsed.ok && (
          <p role="alert" className="text-destructive text-xs">
            {parsed.error}
          </p>
        )}

        {servers.length > 1 && (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-medium">
              This snippet has {servers.length} servers. Import:
            </legend>
            {servers.map((entry, index) => (
              <label key={`${entry.name}-${index}`} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="import-server"
                  checked={index === Math.min(choice, servers.length - 1)}
                  onChange={() => setChoice(index)}
                />
                {entry.name ?? `Server ${index + 1}`}
              </label>
            ))}
          </fieldset>
        )}

        {result && (
          <div className="space-y-3 text-sm">
            <p>
              <span className="text-muted-foreground">Fills in: </span>
              {result.imported.join(", ")}.
            </p>
            {result.ignored.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Not imported:{" "}
                {result.ignored
                  .map((key) => (IGNORED_REASONS[key] ? `${key} (${IGNORED_REASONS[key]})` : key))
                  .join(", ")}
                .
              </p>
            )}
            {result.findings.length > 0 && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-xs font-medium">
                  Ask each user for these values when they install:
                </p>
                {result.findings.map((finding) => (
                  <label key={finding.key} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={!unchecked.has(finding.key)}
                      onCheckedChange={(checked) => toggle(finding.key, checked === true)}
                    />
                    <span>
                      Make <Code>{finding.field}</Code> an input
                      <span className="text-muted-foreground">
                        {finding.reason === "placeholder"
                          ? " · it looks like a placeholder"
                          : " · it looks like a personal credential"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {result.suggestAuthStep && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={!skipAuthStep}
                  onCheckedChange={(checked) => setSkipAuthStep(checked !== true)}
                />
                <span>
                  After install, tell users to run <Code>/reload</Code> and then <Code>/mcp</Code>{" "}
                  to authenticate
                  <span className="text-muted-foreground">
                    {" "}
                    · for servers that sign in with OAuth
                  </span>
                </span>
              </label>
            )}
            {replacesServer && (
              <p className="text-muted-foreground text-xs">
                This replaces the current server settings. The name, summary, inputs and steps are
                kept.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="lg" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="button" size="lg" disabled={!result} onClick={apply}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
