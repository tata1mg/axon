import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { Panel } from "../components";
import {
  BlockListEditor,
  Code,
  FormField,
  IssueList,
  KeyValueEditor,
  LinesEditor,
  SelectInput,
} from "./fields";
import {
  addAuthStep,
  getIn,
  hasAuthStep,
  isObject,
  issuesUnder,
  jsonList,
  makeInput,
  objectList,
  optional,
  parseTags,
  serverMode,
  serverOf,
  setServerMode,
  text,
  textEntries,
  textList,
  uniqueId,
  updateDraft,
  type Path,
} from "./model";
import {
  EXPOSURES,
  HELP_BLOCK_TYPES,
  STEP_BLOCK_TYPES,
  type CatalogIssue,
  type Draft,
  type Json,
  type JsonObject,
  type ServerMode,
} from "./types";

export interface SectionProps {
  draft: Draft;
  /** `remount` resets editors that keep local text, after a change made from outside them. */
  onDraft: (draft: Draft, remount?: boolean) => void;
  disabled: boolean;
  errors: readonly CatalogIssue[];
  warnings: readonly CatalogIssue[];
}

const ICON_SUGGESTIONS = [
  "activity",
  "book",
  "chart",
  "cloud",
  "code",
  "database",
  "globe",
  "key",
  "message",
  "search",
  "server",
  "terminal",
  "ticket",
  "wrench",
];

function Section({
  title,
  description,
  prefix,
  errors,
  warnings,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  prefix: string;
  errors: readonly CatalogIssue[];
  warnings: readonly CatalogIssue[];
  action?: ReactNode;
  children: ReactNode;
}) {
  const sectionErrors = issuesUnder(errors, prefix);
  const sectionWarnings = issuesUnder(warnings, prefix);
  return (
    <Panel title={title} action={action}>
      <div className="space-y-4 p-4">
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
        {(sectionErrors.length > 0 || sectionWarnings.length > 0) && (
          <div className="space-y-2 rounded-md border p-3">
            <IssueList issues={sectionErrors} tone="error" />
            <IssueList issues={sectionWarnings} tone="warning" />
          </div>
        )}
        {children}
      </div>
    </Panel>
  );
}

function TextField({
  id,
  label,
  draft,
  path,
  onDraft,
  disabled,
  hint,
  required,
  mono,
  multiline,
  errors = [],
  placeholder,
}: {
  id: string;
  label: string;
  draft: Draft;
  path: Path;
  onDraft: SectionProps["onDraft"];
  disabled: boolean;
  hint?: ReactNode;
  /** Required fields keep "" so the backend reports them; optional ones are removed when empty. */
  required?: boolean;
  mono?: boolean;
  multiline?: boolean;
  errors?: readonly CatalogIssue[];
  placeholder?: string;
}) {
  const [section, ...rest] = path;
  const value = text(getIn(section === "metadata" ? draft.metadata : draft.spec, rest));
  const change = (next: string) =>
    onDraft(updateDraft(draft, path, required ? next : optional(next)));
  const fieldErrors = errors.filter((issue) => issue.path === path.join("."));
  const props = {
    id,
    value,
    disabled,
    placeholder,
    spellCheck: mono ? false : undefined,
    className: cn(mono && "font-mono"),
    "aria-invalid": fieldErrors.length > 0 || undefined,
  };
  return (
    <FormField label={label} htmlFor={id} hint={hint} issues={fieldErrors}>
      {multiline ? (
        <Textarea {...props} onChange={(event) => change(event.target.value)} />
      ) : (
        <Input {...props} onChange={(event) => change(event.target.value)} />
      )}
    </FormField>
  );
}

// --- details (both kinds) -------------------------------------------------------------------

function TagsInput({
  draft,
  onDraft,
  disabled,
}: Pick<SectionProps, "draft" | "onDraft" | "disabled">) {
  const [value, setValue] = useState(() => textList(draft.metadata.tags).join(", "));
  return (
    <FormField
      label="Tags"
      htmlFor="catalog-tags"
      hint="Comma-separated, for example: data, analytics."
    >
      <Input
        id="catalog-tags"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          setValue(event.target.value);
          const tags = parseTags(event.target.value);
          onDraft(updateDraft(draft, ["metadata", "tags"], tags.length ? tags : undefined));
        }}
      />
    </FormField>
  );
}

export interface ListingFields {
  slug: string;
  slugLocked: boolean;
  featured: boolean;
  sortOrder: string;
  onSlug: (slug: string) => void;
  onFeatured: (featured: boolean) => void;
  onSortOrder: (sortOrder: string) => void;
  /** Called with the new name so a new item can suggest a slug. */
  onName?: (name: string) => void;
}

export function DetailsSection({
  draft,
  onDraft,
  disabled,
  errors,
  warnings,
  listing,
}: SectionProps & { listing: ListingFields }) {
  return (
    <Section title="Details" prefix="metadata" errors={errors} warnings={warnings}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Name"
          htmlFor="catalog-name"
          issues={errors.filter((issue) => issue.path === "metadata.name")}
        >
          <Input
            id="catalog-name"
            value={text(draft.metadata.name)}
            disabled={disabled}
            onChange={(event) => {
              onDraft(updateDraft(draft, ["metadata", "name"], event.target.value));
              listing.onName?.(event.target.value);
            }}
          />
        </FormField>
        <FormField
          label="Slug"
          htmlFor="catalog-slug"
          hint={
            listing.slugLocked
              ? "Fixed after the first publish: users install under this name."
              : "The name users install under: lowercase letters, digits and hyphens."
          }
        >
          <Input
            id="catalog-slug"
            value={listing.slug}
            disabled={disabled || listing.slugLocked}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => listing.onSlug(event.target.value.toLowerCase())}
          />
        </FormField>
      </div>
      <TextField
        id="catalog-summary"
        label="Summary"
        draft={draft}
        path={["metadata", "summary"]}
        onDraft={onDraft}
        disabled={disabled}
        errors={errors}
        hint="One line on the hub's catalog card."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TagsInput draft={draft} onDraft={onDraft} disabled={disabled} />
        <TextField
          id="catalog-docs"
          label="Docs link"
          draft={draft}
          path={["metadata", "docsUrl"]}
          onDraft={onDraft}
          disabled={disabled}
          errors={errors}
          placeholder="https://"
          mono
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Icon" htmlFor="catalog-icon" hint="A name from the hub's icon set.">
          <Input
            id="catalog-icon"
            list="catalog-icon-suggestions"
            value={text(draft.metadata.icon)}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) =>
              onDraft(updateDraft(draft, ["metadata", "icon"], optional(event.target.value)))
            }
          />
          <datalist id="catalog-icon-suggestions">
            {ICON_SUGGESTIONS.map((icon) => (
              <option key={icon} value={icon} />
            ))}
          </datalist>
        </FormField>
        <FormField label="Sort order" htmlFor="catalog-order" hint="Lower numbers come first.">
          <Input
            id="catalog-order"
            type="number"
            min={-10000}
            max={10000}
            value={listing.sortOrder}
            disabled={disabled}
            onChange={(event) => listing.onSortOrder(event.target.value)}
          />
        </FormField>
        <FormField
          label="Featured"
          htmlFor="catalog-featured"
          hint="Featured items are listed first."
        >
          <div className="flex h-7 items-center">
            <Checkbox
              id="catalog-featured"
              checked={listing.featured}
              disabled={disabled}
              onCheckedChange={(checked) => listing.onFeatured(checked === true)}
            />
          </div>
        </FormField>
      </div>
    </Section>
  );
}

// --- MCP server ------------------------------------------------------------------------------

const MODES: readonly { mode: ServerMode; label: string; detail: string }[] = [
  { mode: "stdio", label: "Local command", detail: "Pi starts a program, for example npx." },
  { mode: "http", label: "Remote URL", detail: "Pi connects to a hosted server." },
  {
    mode: "none",
    label: "Instructions only",
    detail: "The hub shows steps; no config is written.",
  },
];

export function ServerSection({ draft, onDraft, disabled, errors, warnings }: SectionProps) {
  const mode = serverMode(draft);
  const server = serverOf(draft) ?? {};
  const field = (key: string): Path => ["spec", "server", key];
  const common = { draft, onDraft, disabled, errors };
  const makeInputFor = (group: "env" | "headers") => (name: string) =>
    onDraft(makeInput(draft, { group, name }), true);

  return (
    <Section title="Server" prefix="spec.server" errors={errors} warnings={warnings}>
      <div role="radiogroup" aria-label="Server type" className="grid gap-2 sm:grid-cols-3">
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={mode === option.mode}
            disabled={disabled}
            onClick={() => onDraft(setServerMode(draft, option.mode), true)}
            className={cn(
              "rounded-lg border p-3 text-left transition-colors disabled:opacity-60",
              mode === option.mode ? "border-primary bg-primary/5" : "hover:bg-muted/50",
            )}
          >
            <span className="block text-sm font-medium">{option.label}</span>
            <span className="text-muted-foreground block text-xs">{option.detail}</span>
          </button>
        ))}
      </div>

      {mode === "stdio" && (
        <>
          <TextField
            {...common}
            id="server-command"
            label="Command"
            path={field("command")}
            required
            mono
            placeholder="npx"
          />
          <FormField label="Arguments" htmlFor="server-args" hint="One per line.">
            <LinesEditor
              id="server-args"
              value={textList(server.args)}
              disabled={disabled}
              placeholder={"-y\n@scope/package@1.2.3"}
              onChange={(lines) =>
                onDraft(updateDraft(draft, field("args"), lines.length ? lines : undefined))
              }
            />
          </FormField>
          <FormField
            label="Environment"
            hint={
              <>
                Use <Code>{"${input:<id>}"}</Code> for values each user enters. Other{" "}
                <Code>{"${NAME}"}</Code> references are expanded by Pi.
              </>
            }
          >
            <KeyValueEditor
              label="Variable"
              value={textEntries(server.env)}
              disabled={disabled}
              keyPlaceholder="NAME"
              valuePlaceholder="value"
              onMakeInput={makeInputFor("env")}
              onChange={(entries) =>
                onDraft(
                  updateDraft(
                    draft,
                    field("env"),
                    Object.keys(entries).length ? entries : undefined,
                  ),
                )
              }
            />
          </FormField>
          <TextField
            {...common}
            id="server-cwd"
            label="Working directory (optional)"
            path={field("cwd")}
            mono
          />
        </>
      )}

      {mode === "http" && (
        <>
          <TextField
            {...common}
            id="server-url"
            label="URL"
            path={field("url")}
            required
            mono
            placeholder="https://example.com/mcp"
          />
          <FormField label="Headers">
            <KeyValueEditor
              label="Header"
              value={textEntries(server.headers)}
              disabled={disabled}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ${input:token}"
              onMakeInput={makeInputFor("headers")}
              onChange={(entries) =>
                onDraft(
                  updateDraft(
                    draft,
                    field("headers"),
                    Object.keys(entries).length ? entries : undefined,
                  ),
                )
              }
            />
          </FormField>
          <FormField label="Transport type" htmlFor="server-type">
            <SelectInput
              id="server-type"
              value={text(server.type)}
              disabled={disabled}
              onChange={(event) =>
                onDraft(updateDraft(draft, field("type"), optional(event.target.value)))
              }
            >
              <option value="">Automatic (recommended)</option>
              <option value="streamable-http">streamable-http</option>
              <option value="http">http</option>
            </SelectInput>
          </FormField>
        </>
      )}

      {mode === "none" ? (
        <p className="text-muted-foreground text-sm">
          The hub shows the setup steps below and does not write any configuration. Use this for
          servers that need a desktop app or an access request first.
        </p>
      ) : (
        <>
          <TextField
            {...common}
            id="server-description"
            label="Description"
            path={field("description")}
            multiline
            hint="What the server gives Pi. Stored in the user's mcp.json."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Exposure" htmlFor="server-exposure">
              <SelectInput
                id="server-exposure"
                value={text(server.exposure) || "codemode"}
                disabled={disabled}
                onChange={(event) =>
                  onDraft(updateDraft(draft, field("exposure"), event.target.value))
                }
              >
                {EXPOSURES.map((exposure) => (
                  <option key={exposure} value={exposure}>
                    {exposure === "codemode" ? "codemode (recommended)" : exposure}
                  </option>
                ))}
              </SelectInput>
            </FormField>
            <FormField label="Timeout in seconds (optional)" htmlFor="server-timeout">
              <Input
                id="server-timeout"
                type="number"
                min={1}
                value={typeof server.timeout === "number" ? String(server.timeout) : ""}
                disabled={disabled}
                onChange={(event) =>
                  onDraft(
                    updateDraft(
                      draft,
                      field("timeout"),
                      event.target.value === "" ? undefined : Number(event.target.value),
                    ),
                  )
                }
              />
            </FormField>
          </div>
        </>
      )}
    </Section>
  );
}

// --- inputs and prerequisites ------------------------------------------------------------

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" size="icon-sm" variant="ghost" aria-label={label} onClick={onClick}>
      <Trash2 aria-hidden />
    </Button>
  );
}

function ListCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-muted/30 space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

export function InputsSection({ draft, onDraft, disabled, errors, warnings }: SectionProps) {
  const inputs = jsonList(draft.spec.inputs);
  const set = (index: number, key: string, value: Json | undefined) =>
    onDraft(updateDraft(draft, ["spec", "inputs", index, key], value));
  const taken = new Set(objectList(inputs).map((input) => text(input.id)));
  return (
    <Section
      title="Inputs"
      prefix="spec.inputs"
      errors={errors}
      warnings={warnings}
      description={
        <>
          Values each user enters when installing, such as a personal API key. Reference one in the
          server as <Code>{"${input:<id>}"}</Code>. Values stay on the user&apos;s machine. Renaming
          an ID does not update its references.
        </>
      }
    >
      {inputs.map((entry, index) => {
        const input = isObject(entry) ? entry : {};
        const prefix = `input-${index}`;
        return (
          <ListCard
            key={prefix}
            title={`${index + 1}. ${text(input.label) || text(input.id) || "Input"}`}
            action={
              !disabled && (
                <RemoveButton
                  label={`Remove input ${index + 1}`}
                  onClick={() => onDraft(updateDraft(draft, ["spec", "inputs", index], undefined))}
                />
              )
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="ID" htmlFor={`${prefix}-id`}>
                <Input
                  id={`${prefix}-id`}
                  value={text(input.id)}
                  disabled={disabled}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => set(index, "id", event.target.value)}
                />
              </FormField>
              <FormField label="Label" htmlFor={`${prefix}-label`}>
                <Input
                  id={`${prefix}-label`}
                  value={text(input.label)}
                  disabled={disabled}
                  onChange={(event) => set(index, "label", event.target.value)}
                />
              </FormField>
              <FormField label="Type" htmlFor={`${prefix}-type`}>
                <SelectInput
                  id={`${prefix}-type`}
                  value={text(input.type) || "text"}
                  disabled={disabled}
                  onChange={(event) => set(index, "type", event.target.value)}
                >
                  <option value="text">Text</option>
                  <option value="secret">Secret (masked)</option>
                  <option value="url">URL</option>
                  <option value="path">File path</option>
                </SelectInput>
              </FormField>
              <FormField label="Required" htmlFor={`${prefix}-required`}>
                <div className="flex h-7 items-center">
                  <Checkbox
                    id={`${prefix}-required`}
                    checked={input.required !== false}
                    disabled={disabled}
                    onCheckedChange={(checked) => set(index, "required", checked === true)}
                  />
                </div>
              </FormField>
              <FormField label="Placeholder (optional)" htmlFor={`${prefix}-placeholder`}>
                <Input
                  id={`${prefix}-placeholder`}
                  value={text(input.placeholder)}
                  disabled={disabled}
                  onChange={(event) => set(index, "placeholder", optional(event.target.value))}
                />
              </FormField>
              <FormField
                label="Pattern (optional)"
                htmlFor={`${prefix}-pattern`}
                hint="A regular expression the value must match."
              >
                <Input
                  id={`${prefix}-pattern`}
                  value={text(input.pattern)}
                  disabled={disabled}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => set(index, "pattern", optional(event.target.value))}
                />
              </FormField>
            </div>
            <FormField label="Help shown under the field">
              <BlockListEditor
                idPrefix={`${prefix}-help`}
                blocks={jsonList(input.help)}
                types={HELP_BLOCK_TYPES}
                disabled={disabled}
                emptyText="No help."
                onChange={(blocks) => set(index, "help", blocks.length ? blocks : undefined)}
              />
            </FormField>
          </ListCard>
        );
      })}
      {!disabled && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onDraft(
              updateDraft(
                draft,
                ["spec", "inputs"],
                [
                  ...inputs,
                  { id: uniqueId("value", taken), label: "", type: "text", required: true },
                ],
              ),
            )
          }
        >
          <Plus aria-hidden data-icon="inline-start" />
          Add input
        </Button>
      )}
    </Section>
  );
}

const PREREQUISITE_PRESETS: readonly { name: string; value: JsonObject }[] = [
  {
    name: "Node.js (npx)",
    value: {
      id: "node",
      label: "Node.js (provides npx)",
      detect: { executable: "npx" },
      help: [{ type: "command", command: "brew install node" }],
    },
  },
  {
    name: "uv (uvx)",
    value: {
      id: "uv",
      label: "uv (provides uvx)",
      detect: { executable: "uvx" },
      help: [{ type: "command", command: "brew install uv" }],
    },
  },
  {
    name: "Docker",
    value: {
      id: "docker",
      label: "Docker",
      detect: { executable: "docker" },
      help: [
        { type: "link", label: "Install Docker Desktop", url: "https://docs.docker.com/desktop/" },
      ],
    },
  },
];

export function PrerequisitesSection({ draft, onDraft, disabled, errors, warnings }: SectionProps) {
  const prerequisites = jsonList(draft.spec.prerequisites);
  const taken = new Set(objectList(prerequisites).map((entry) => text(entry.id)));
  const set = (index: number, path: Path, value: Json | undefined) =>
    onDraft(updateDraft(draft, ["spec", "prerequisites", index, ...path], value));
  const add = (value: JsonObject) =>
    onDraft(updateDraft(draft, ["spec", "prerequisites"], [...prerequisites, value]));
  return (
    <Section
      title="Prerequisites"
      prefix="spec.prerequisites"
      errors={errors}
      warnings={warnings}
      description="Tools the user needs first. The hub checks whether the executable is on their PATH and shows the help when it is missing."
    >
      {prerequisites.map((entry, index) => {
        const prerequisite = isObject(entry) ? entry : {};
        const detect = isObject(prerequisite.detect) ? prerequisite.detect : {};
        const prefix = `prerequisite-${index}`;
        return (
          <ListCard
            key={prefix}
            title={`${index + 1}. ${text(prerequisite.label) || text(prerequisite.id) || "Prerequisite"}`}
            action={
              !disabled && (
                <RemoveButton
                  label={`Remove prerequisite ${index + 1}`}
                  onClick={() =>
                    onDraft(updateDraft(draft, ["spec", "prerequisites", index], undefined))
                  }
                />
              )
            }
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="ID" htmlFor={`${prefix}-id`}>
                <Input
                  id={`${prefix}-id`}
                  value={text(prerequisite.id)}
                  disabled={disabled}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => set(index, ["id"], event.target.value)}
                />
              </FormField>
              <FormField label="Label" htmlFor={`${prefix}-label`}>
                <Input
                  id={`${prefix}-label`}
                  value={text(prerequisite.label)}
                  disabled={disabled}
                  onChange={(event) => set(index, ["label"], event.target.value)}
                />
              </FormField>
              <FormField label="Executable to detect" htmlFor={`${prefix}-detect`}>
                <Input
                  id={`${prefix}-detect`}
                  value={text(detect.executable)}
                  disabled={disabled}
                  spellCheck={false}
                  className="font-mono"
                  placeholder="npx"
                  onChange={(event) =>
                    set(
                      index,
                      ["detect"],
                      event.target.value ? { executable: event.target.value } : undefined,
                    )
                  }
                />
              </FormField>
            </div>
            <FormField label="Install help">
              <BlockListEditor
                idPrefix={`${prefix}-help`}
                blocks={jsonList(prerequisite.help)}
                types={HELP_BLOCK_TYPES}
                disabled={disabled}
                emptyText="No help."
                onChange={(blocks) => set(index, ["help"], blocks.length ? blocks : undefined)}
              />
            </FormField>
          </ListCard>
        );
      })}
      {!disabled && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => add({ id: uniqueId("tool", taken), label: "" })}
          >
            <Plus aria-hidden data-icon="inline-start" />
            Add prerequisite
          </Button>
          {PREREQUISITE_PRESETS.filter((preset) => !taken.has(text(preset.value.id))).map(
            (preset) => (
              <Button
                key={preset.name}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => add(preset.value)}
              >
                <Plus aria-hidden data-icon="inline-start" />
                {preset.name}
              </Button>
            ),
          )}
        </div>
      )}
    </Section>
  );
}

// --- steps -----------------------------------------------------------------------------------

export function StepsSection({ draft, onDraft, disabled, errors, warnings }: SectionProps) {
  return (
    <Section
      title="Setup steps"
      prefix="spec.steps"
      errors={errors}
      warnings={warnings}
      description="Shown before installing, in this order. Inputs and prerequisites without a step of their own are shown anyway."
    >
      <BlockListEditor
        idPrefix="step"
        blocks={jsonList(draft.spec.steps)}
        types={STEP_BLOCK_TYPES}
        inputIds={objectList(draft.spec.inputs).map((input) => text(input.id))}
        prerequisiteIds={objectList(draft.spec.prerequisites).map((entry) => text(entry.id))}
        disabled={disabled}
        emptyText="No setup steps."
        onChange={(blocks) =>
          onDraft(updateDraft(draft, ["spec", "steps"], blocks.length ? blocks : undefined))
        }
      />
    </Section>
  );
}

export function AfterInstallSection({ draft, onDraft, disabled, errors, warnings }: SectionProps) {
  const offerAuthStep = !disabled && serverMode(draft) === "http" && !hasAuthStep(draft);
  return (
    <Section
      title="After install"
      prefix="spec.afterInstall"
      errors={errors}
      warnings={warnings}
      description="Shown once the server is added to the user's config."
      action={
        offerAuthStep && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onDraft(addAuthStep(draft))}
          >
            <Plus aria-hidden data-icon="inline-start" />
            /reload and /mcp step
          </Button>
        )
      }
    >
      <BlockListEditor
        idPrefix="after"
        blocks={jsonList(draft.spec.afterInstall)}
        types={HELP_BLOCK_TYPES}
        disabled={disabled}
        emptyText="Nothing after install."
        onChange={(blocks) =>
          onDraft(updateDraft(draft, ["spec", "afterInstall"], blocks.length ? blocks : undefined))
        }
      />
    </Section>
  );
}

// --- skill (preview) -----------------------------------------------------------------------

export function SkillSourceSection({ draft, onDraft, disabled, errors, warnings }: SectionProps) {
  return (
    <Section
      title="Source"
      prefix="spec.source"
      errors={errors}
      warnings={warnings}
      description="Skills are a preview: developers can see them in the hub but not install them yet. How a skill's files are delivered will be added later."
    >
      <TextField
        id="skill-notes"
        label="Notes"
        draft={draft}
        path={["spec", "source", "notes"]}
        onDraft={onDraft}
        disabled={disabled}
        errors={errors}
        multiline
        required
        hint="For admins: where the skill lives today and anything needed to package it."
      />
    </Section>
  );
}

// --- JSON tab ---------------------------------------------------------------------------------

export function JsonEditor({
  draft,
  disabled,
  onApply,
}: {
  draft: Draft;
  disabled: boolean;
  onApply: (draft: Draft) => void;
}) {
  const [source, setSource] = useState(() => JSON.stringify(draft, null, 2));
  const [error, setError] = useState<string>();

  function apply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      setError("This isn't valid JSON.");
      return;
    }
    if (!isObject(parsed) || !isObject(parsed.metadata) || !isObject(parsed.spec)) {
      setError('The draft must be an object with "metadata" and "spec" objects.');
      return;
    }
    const extra = Object.keys(parsed).filter((key) => key !== "metadata" && key !== "spec");
    if (extra.length > 0) {
      setError(`Remove ${extra.join(", ")}: a draft has only "metadata" and "spec".`);
      return;
    }
    setError(undefined);
    onApply({ metadata: parsed.metadata, spec: parsed.spec });
  }

  return (
    <Panel title="Draft JSON">
      <div className="space-y-3 p-4">
        <p className="text-muted-foreground text-xs">
          For fields the form doesn&apos;t cover. Apply checks the JSON; saving still needs Save.
        </p>
        <Textarea
          aria-label="Draft JSON"
          value={source}
          disabled={disabled}
          spellCheck={false}
          className="min-h-96 font-mono"
          onChange={(event) => setSource(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        {!disabled && (
          <Button type="button" size="lg" onClick={apply}>
            Apply to form
          </Button>
        )}
      </div>
    </Panel>
  );
}
