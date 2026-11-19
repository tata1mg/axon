import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Plus,
  Trash2,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  BLOCK_LABELS,
  describePath,
  inputSuggestion,
  isObject,
  moveItem,
  newBlock,
  STATUS_LABELS,
  text,
  TIER_LABELS,
} from "./model";
import type {
  BlockType,
  CatalogIssue,
  CatalogItemSummary,
  InstallTier,
  Json,
  JsonObject,
} from "./types";

// --- layout ------------------------------------------------------------------------------

export function FormField({
  label,
  htmlFor,
  hint,
  issues = [],
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  issues?: readonly CatalogIssue[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {issues.map((issue) => (
        <p key={`${issue.path}:${issue.message}`} className="text-destructive text-xs">
          {issue.message}
        </p>
      ))}
    </div>
  );
}

export function SelectInput({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input bg-input/20 focus-visible:border-ring focus-visible:ring-ring/30 dark:bg-input/30 h-7 w-full min-w-0 rounded-md border px-1.5 text-sm outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-xs/relaxed",
        className,
      )}
      {...props}
    />
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{children}</code>;
}

/** Issues reported for one form section, with paths turned into the form's labels. */
export function IssueList({
  issues,
  tone,
  className,
}: {
  issues: readonly CatalogIssue[];
  tone: "error" | "warning";
  className?: string;
}) {
  if (issues.length === 0) return null;
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <ul className={cn("space-y-1.5 text-xs", className)}>
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`} className="flex gap-2">
          <Icon
            aria-hidden
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              tone === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
            )}
          />
          <span className="min-w-0">
            <span className="font-medium">{describePath(issue.path)}</span>
            <span className="text-muted-foreground"> · {issue.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// --- badges ------------------------------------------------------------------------------

export function TierBadge({ tier }: { tier: InstallTier | null }) {
  if (!tier) return null;
  return <Badge variant="outline">{TIER_LABELS[tier]}</Badge>;
}

export function StatusBadges({
  item,
}: {
  item: Pick<CatalogItemSummary, "status" | "has_unpublished_changes">;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge
        variant={
          item.status === "published"
            ? "default"
            : item.status === "draft"
              ? "secondary"
              : "outline"
        }
      >
        {STATUS_LABELS[item.status]}
      </Badge>
      {item.has_unpublished_changes && (
        <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
          Unpublished changes
        </Badge>
      )}
    </span>
  );
}

export function ProblemCounts({ errors, warnings }: { errors: number; warnings: number }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {errors > 0 && (
        <Badge variant="destructive">
          {errors} error{errors === 1 ? "" : "s"}
        </Badge>
      )}
      {warnings > 0 && (
        <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
          {warnings} warning{warnings === 1 ? "" : "s"}
        </Badge>
      )}
    </span>
  );
}

// --- list editors with local text state --------------------------------------------------
//
// These keep what the admin is typing (blank lines, a half-typed key) locally and emit
// only the cleaned value. The parent remounts them with a new `key` when the draft is
// replaced from outside (import, JSON tab, reload, "Make input").

export function LinesEditor({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  value: readonly string[];
  onChange: (lines: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(() => value.join("\n"));
  return (
    <Textarea
      id={id}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      className="font-mono"
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value.split("\n").filter((line) => line.trim() !== ""));
      }}
    />
  );
}

interface Row {
  key: string;
  value: string;
  id: number;
}

export function KeyValueEditor({
  label,
  value,
  onChange,
  onMakeInput,
  disabled,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  value: readonly (readonly [string, string])[];
  onChange: (entries: Record<string, string>) => void;
  /** Offered for literal values; highlighted when the value looks like a credential or placeholder. */
  onMakeInput?: (name: string) => void;
  disabled?: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    value.map(([key, entry], index) => ({ key, value: entry, id: index })),
  );
  const [nextId, setNextId] = useState(value.length);

  function update(next: Row[]) {
    setRows(next);
    onChange(
      Object.fromEntries(
        next.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
      ),
    );
  }

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.key.trim(), (counts.get(row.key.trim()) ?? 0) + 1);

  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const name = row.key.trim();
        const suggestion = name && row.value ? inputSuggestion(name, row.value) : null;
        const literal = name !== "" && row.value !== "" && !row.value.includes("${");
        return (
          <div key={row.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Input
                aria-label={`${label} name ${index + 1}`}
                value={row.key}
                disabled={disabled}
                placeholder={keyPlaceholder}
                spellCheck={false}
                className="font-mono sm:w-56"
                onChange={(event) =>
                  update(rows.map((r) => (r.id === row.id ? { ...r, key: event.target.value } : r)))
                }
              />
              <Input
                aria-label={`${label} value ${index + 1}`}
                value={row.value}
                disabled={disabled}
                placeholder={valuePlaceholder}
                spellCheck={false}
                className="font-mono"
                onChange={(event) =>
                  update(
                    rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r)),
                  )
                }
              />
              {onMakeInput && literal && !disabled && (
                <Button
                  type="button"
                  size="sm"
                  variant={suggestion ? "outline" : "ghost"}
                  className={cn(
                    suggestion && "border-amber-500/50 text-amber-700 dark:text-amber-400",
                  )}
                  title="Ask each user for this value when they install"
                  onClick={() => onMakeInput(name)}
                >
                  <WandSparkles aria-hidden data-icon="inline-start" />
                  Make input
                </Button>
              )}
              {!disabled && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${label.toLowerCase()} ${name || index + 1}`}
                  onClick={() => update(rows.filter((r) => r.id !== row.id))}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
            {suggestion && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {suggestion === "placeholder"
                  ? "This looks like a placeholder. Make it an input so each user enters their own value."
                  : "Every user would receive this value. If it is a personal credential, make it an input."}
              </p>
            )}
            {name && (counts.get(name) ?? 0) > 1 && (
              <p className="text-destructive text-xs">
                This name is used more than once; the last value wins.
              </p>
            )}
          </div>
        );
      })}
      {!disabled && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setRows([...rows, { key: "", value: "", id: nextId }]);
            setNextId(nextId + 1);
          }}
        >
          <Plus aria-hidden data-icon="inline-start" />
          Add {label.toLowerCase()}
        </Button>
      )}
    </div>
  );
}

// --- step blocks -------------------------------------------------------------------------

function BlockFields({
  block,
  idPrefix,
  disabled,
  inputIds,
  prerequisiteIds,
  onChange,
}: {
  block: JsonObject;
  idPrefix: string;
  disabled?: boolean;
  inputIds: readonly string[];
  prerequisiteIds: readonly string[];
  onChange: (block: JsonObject) => void;
}) {
  const set = (key: string, value: string) => onChange({ ...block, [key]: value });
  const field = (key: string) => `${idPrefix}-${key}`;
  switch (block.type) {
    case "text":
      return (
        <FormField
          label="Text"
          htmlFor={field("text")}
          hint={
            <>
              Supports <Code>`code`</Code>, <Code>**bold**</Code> and{" "}
              <Code>[label](https://…)</Code>.
            </>
          }
        >
          <Textarea
            id={field("text")}
            value={text(block.text)}
            disabled={disabled}
            onChange={(event) => set("text", event.target.value)}
          />
        </FormField>
      );
    case "command":
      return (
        <div className="grid gap-3">
          <FormField
            label="Command"
            htmlFor={field("command")}
            hint="Shown with a Copy button. The hub never runs it."
          >
            <Textarea
              id={field("command")}
              value={text(block.command)}
              disabled={disabled}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => set("command", event.target.value)}
            />
          </FormField>
          <FormField label="Label (optional)" htmlFor={field("label")}>
            <Input
              id={field("label")}
              value={text(block.label)}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  event.target.value
                    ? { ...block, label: event.target.value }
                    : Object.fromEntries(Object.entries(block).filter(([key]) => key !== "label")),
                )
              }
            />
          </FormField>
        </div>
      );
    case "link":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Button label" htmlFor={field("label")}>
            <Input
              id={field("label")}
              value={text(block.label)}
              disabled={disabled}
              onChange={(event) => set("label", event.target.value)}
            />
          </FormField>
          <FormField label="URL" htmlFor={field("url")} hint="https:// only.">
            <Input
              id={field("url")}
              value={text(block.url)}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => set("url", event.target.value)}
            />
          </FormField>
        </div>
      );
    case "callout":
      return (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <FormField label="Tone" htmlFor={field("tone")}>
            <SelectInput
              id={field("tone")}
              value={text(block.tone) || "info"}
              disabled={disabled}
              onChange={(event) => set("tone", event.target.value)}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
            </SelectInput>
          </FormField>
          <FormField label="Text" htmlFor={field("text")}>
            <Textarea
              id={field("text")}
              value={text(block.text)}
              disabled={disabled}
              onChange={(event) => set("text", event.target.value)}
            />
          </FormField>
        </div>
      );
    case "input":
      return (
        <FormField
          label="Input"
          htmlFor={field("input")}
          hint="Shows this input's field at this point in the steps."
        >
          <SelectInput
            id={field("input")}
            value={text(block.input)}
            disabled={disabled}
            onChange={(event) => set("input", event.target.value)}
          >
            <option value="">Choose an input…</option>
            {inputIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </SelectInput>
        </FormField>
      );
    case "check":
      return (
        <FormField
          label="Prerequisite"
          htmlFor={field("prerequisite")}
          hint="Shows whether the user has it installed, with its install help."
        >
          <SelectInput
            id={field("prerequisite")}
            value={text(block.prerequisite)}
            disabled={disabled}
            onChange={(event) => set("prerequisite", event.target.value)}
          >
            <option value="">Choose a prerequisite…</option>
            {prerequisiteIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </SelectInput>
        </FormField>
      );
    case "confirm":
      return (
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <FormField label="ID" htmlFor={field("id")}>
            <Input
              id={field("id")}
              value={text(block.id)}
              disabled={disabled}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => set("id", event.target.value)}
            />
          </FormField>
          <FormField
            label="Checkbox label"
            htmlFor={field("label")}
            hint="Install stays disabled until it is ticked."
          >
            <Input
              id={field("label")}
              value={text(block.label)}
              disabled={disabled}
              onChange={(event) => set("label", event.target.value)}
            />
          </FormField>
        </div>
      );
    default:
      return (
        <p className="text-muted-foreground text-xs">
          This block type is not supported. Edit or remove it in the JSON tab.
        </p>
      );
  }
}

export function BlockListEditor({
  idPrefix,
  blocks,
  types,
  inputIds = [],
  prerequisiteIds = [],
  disabled,
  emptyText,
  onChange,
}: {
  idPrefix: string;
  blocks: readonly Json[];
  types: readonly BlockType[];
  inputIds?: readonly string[];
  prerequisiteIds?: readonly string[];
  disabled?: boolean;
  emptyText: string;
  onChange: (blocks: Json[]) => void;
}) {
  const confirmIds = new Set(
    blocks
      .filter(isObject)
      .filter((block) => block.type === "confirm")
      .map((block) => text(block.id)),
  );
  return (
    <div className="space-y-3">
      {blocks.length === 0 && <p className="text-muted-foreground text-xs">{emptyText}</p>}
      {blocks.map((block, index) => {
        const object = isObject(block) ? block : {};
        const label = BLOCK_LABELS[text(object.type) as BlockType] ?? "Unknown block";
        return (
          <div key={`${idPrefix}-${index}`} className="bg-muted/30 space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                {index + 1}. {label}
              </span>
              {!disabled && (
                <span className="flex gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move block ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => onChange(moveItem(blocks, index, -1))}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move block ${index + 1} down`}
                    disabled={index === blocks.length - 1}
                    onClick={() => onChange(moveItem(blocks, index, 1))}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove block ${index + 1}`}
                    onClick={() => onChange(blocks.filter((_, position) => position !== index))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              )}
            </div>
            <BlockFields
              block={object}
              idPrefix={`${idPrefix}-${index}`}
              disabled={disabled}
              inputIds={inputIds}
              prerequisiteIds={prerequisiteIds}
              onChange={(next) =>
                onChange(blocks.map((entry, position) => (position === index ? next : entry)))
              }
            />
          </div>
        );
      })}
      {!disabled && (
        <div className="flex flex-wrap gap-1.5">
          {types.map((type) => (
            <Button
              key={type}
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onChange([...blocks, newBlock(type, inputIds, prerequisiteIds, confirmIds)])
              }
            >
              <Plus aria-hidden data-icon="inline-start" />
              {BLOCK_LABELS[type]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
