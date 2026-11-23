// Pure catalog UI rules, shared by the React pages and unit tests. No DOM access here.
// Types mirror ../../catalog.ts (CatalogView) and ../../catalog-schema.ts.

export type Tier = "one_click" | "guided" | "manual";

export type HelpBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "command"; readonly command: string; readonly label?: string }
  | { readonly type: "link"; readonly label: string; readonly url: string }
  | { readonly type: "callout"; readonly tone: "info" | "warning"; readonly text: string };
export type StepBlock =
  | HelpBlock
  | { readonly type: "input"; readonly input: string }
  | { readonly type: "check"; readonly prerequisite: string }
  | { readonly type: "confirm"; readonly id: string; readonly label: string };

export interface CatalogInput {
  readonly id: string;
  readonly label: string;
  readonly type: "text" | "secret" | "url" | "path";
  readonly required: boolean;
  readonly placeholder?: string;
  readonly pattern?: string;
  readonly help: readonly HelpBlock[];
}

export interface Prerequisite {
  readonly id: string;
  readonly label: string;
  readonly detect?: { readonly executable: string };
  readonly help: readonly HelpBlock[];
}

export interface ServerTemplate {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly description?: string;
  readonly exposure: string;
}

export type LocalState =
  | { readonly state: "not_installed" }
  | { readonly state: "name_in_use"; readonly name: string }
  | {
      readonly state: "installed" | "update_available" | "changed_locally";
      readonly name: string;
      readonly installedRevision: number;
      readonly changedLocally: boolean;
    };

interface ItemBase {
  readonly slug: string;
  readonly revision: number;
  readonly tier: Tier | null;
  readonly featured: boolean;
  readonly publishedAt: string;
  readonly metadata: {
    readonly name: string;
    readonly summary: string;
    readonly tags: readonly string[];
    readonly docsUrl?: string;
    readonly icon?: string;
  };
  readonly local: LocalState;
  readonly prerequisiteStatus: readonly {
    readonly id: string;
    readonly found: boolean;
    readonly path?: string;
  }[];
}

export interface McpItem extends ItemBase {
  readonly kind: "mcp";
  readonly spec: {
    readonly server?: ServerTemplate;
    readonly inputs: readonly CatalogInput[];
    readonly prerequisites: readonly Prerequisite[];
    readonly steps: readonly StepBlock[];
    readonly afterInstall: readonly HelpBlock[];
  };
}

export interface SkillItem extends ItemBase {
  readonly kind: "skill";
}

export type CatalogItem = McpItem | SkillItem;

export type CatalogView =
  | {
      readonly status: "ok";
      readonly items: readonly CatalogItem[];
      readonly skipped: number;
      readonly configRevision: string;
    }
  | { readonly status: "signin_required" }
  | { readonly status: "unavailable"; readonly message: string };

export const TIER_LABELS: Record<Tier, string> = {
  one_click: "One-click",
  guided: "Guided",
  manual: "Steps only",
};

export type Action = "install" | "update" | "reset" | "install_as" | "steps" | "details";

/** The main button on a catalog card, by local state. */
export function actionFor(item: McpItem): { readonly action: Action; readonly label: string } {
  if (!item.spec.server) return { action: "steps", label: "View steps" };
  switch (item.local.state) {
    case "not_installed":
      return { action: "install", label: "Install" };
    case "name_in_use":
      return { action: "install_as", label: "Install as…" };
    case "update_available":
      return { action: "update", label: "Update" };
    case "changed_locally":
      return { action: "reset", label: "Reset to catalog" };
    case "installed":
      return { action: "details", label: "Details" };
  }
}

export function stateTag(
  item: McpItem,
): { readonly label: string; readonly tone: "ok" | "warn" | "muted" } | null {
  switch (item.local.state) {
    case "installed":
      return { label: "Installed", tone: "ok" };
    case "update_available":
      return { label: "Update available", tone: "warn" };
    case "changed_locally":
      return { label: "Changed locally", tone: "warn" };
    case "name_in_use":
      return { label: "Name in use", tone: "muted" };
    default:
      return null;
  }
}

/** Installing over an existing entry: blank secrets keep their stored values. */
export function isUpdate(item: McpItem): boolean {
  return item.local.state === "update_available" || item.local.state === "changed_locally";
}

/** Inputs placed by an `input` step, in order, then the rest at the end. */
export function unplacedInputs(item: McpItem): CatalogInput[] {
  const placed = new Set(
    item.spec.steps.flatMap((block) => (block.type === "input" ? [block.input] : [])),
  );
  return item.spec.inputs.filter((input) => !placed.has(input.id));
}

/** Prerequisites without a `check` step are shown before the steps. */
export function unplacedPrerequisites(item: McpItem): Prerequisite[] {
  const placed = new Set(
    item.spec.steps.flatMap((block) => (block.type === "check" ? [block.prerequisite] : [])),
  );
  return item.spec.prerequisites.filter((prerequisite) => !placed.has(prerequisite.id));
}

export interface InstallForm {
  readonly values: Readonly<Record<string, string>>;
  readonly confirmed: ReadonlySet<string>;
  readonly name: string;
}

export const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/** Why Install is disabled, or null when it can run. The hub checks everything again. */
export function blocker(item: McpItem, form: InstallForm): string | null {
  if (!item.spec.server) return "This entry has setup steps only.";
  const updating = isUpdate(item);
  for (const input of item.spec.inputs) {
    // Updates may leave inputs blank to keep the values already stored.
    if (input.required && !updating && !(form.values[input.id] ?? "").trim())
      return `Enter ${input.label}.`;
  }
  for (const block of item.spec.steps)
    if (block.type === "confirm" && !form.confirmed.has(block.id)) return `Tick “${block.label}”.`;
  if (item.local.state === "name_in_use" && !NAME_PATTERN.test(form.name))
    return "Choose a server name of letters, digits, hyphens and underscores.";
  return null;
}

export function needsTrust(item: McpItem): boolean {
  return item.spec.server?.command !== undefined;
}

const REFERENCE = /\$\{input:([a-z][a-z0-9_]{0,39})\}/g;

/** What will be written, with secrets masked and unfilled inputs named. */
export function reviewRows(
  item: McpItem,
  values: Readonly<Record<string, string>>,
): { readonly label: string; readonly value: string }[] {
  const server = item.spec.server;
  if (!server) return [];
  const inputs = new Map(item.spec.inputs.map((input) => [input.id, input]));
  const updating = isUpdate(item);
  const show = (raw: string) =>
    raw.replace(REFERENCE, (_match, id: string) => {
      const input = inputs.get(id);
      const value = (values[id] ?? "").trim();
      if (!value) return updating ? "‹stored value›" : `‹${input?.label ?? id}›`;
      return input?.type === "secret" ? "••••••" : value;
    });
  const rows: { label: string; value: string }[] = [];
  if (server.command !== undefined)
    rows.push({ label: "Runs", value: show([server.command, ...(server.args ?? [])].join(" ")) });
  for (const [name, value] of Object.entries(server.env ?? {}))
    rows.push({ label: `env ${name}`, value: show(value) });
  if (server.cwd !== undefined) rows.push({ label: "Working directory", value: show(server.cwd) });
  if (server.url !== undefined) rows.push({ label: "URL", value: show(server.url) });
  for (const [name, value] of Object.entries(server.headers ?? {}))
    rows.push({ label: `header ${name}`, value: show(value) });
  rows.push({ label: "Exposure", value: server.exposure });
  return rows;
}

export type InlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]*)\]\((https:\/\/[^)\s]+)\)/g;

/** The text block syntax: `code`, **bold** and [label](https://...). Never HTML. */
export function inlineTokens(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    if (match.index > last) tokens.push({ kind: "text", text: source.slice(last, match.index) });
    if (match[1] !== undefined) tokens.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "bold", text: match[2] });
    else tokens.push({ kind: "link", text: match[3] || (match[4] ?? ""), href: match[4] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < source.length) tokens.push({ kind: "text", text: source.slice(last) });
  return tokens;
}

/** Only https links leave the hub, opened as new tabs without a referrer. */
export function safeHref(url: string): string | undefined {
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
