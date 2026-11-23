/**
 * Catalog editor logic with no React or DOM: reading and updating drafts, the
 * "Import from mcp.json" conversion, turning values into user inputs, and display
 * helpers. `node --test` runs it directly, so relative imports name their `.ts` file.
 *
 * The placeholder and credential patterns mirror the backend's publishing warnings in
 * apps/backend/app/services/catalog/specs.py.
 */
import {
  EXPOSURES,
  type BlockType,
  type CatalogIssue,
  type CatalogKind,
  type CatalogStatus,
  type Draft,
  type InputType,
  type InstallTier,
  type Json,
  type JsonObject,
  type ServerMode,
} from "./types.ts";

// --- reading JSON defensively ------------------------------------------------------------

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function textEntries(value: unknown): [string, string][] {
  return isObject(value)
    ? Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
    : [];
}

export function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function jsonList(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

export type Path = readonly (string | number)[];

export function getIn(root: Json | undefined, path: Path): Json | undefined {
  let current = root;
  for (const key of path) {
    if (typeof key === "number") current = Array.isArray(current) ? current[key] : undefined;
    else current = isObject(current) ? current[key] : undefined;
  }
  return current;
}

function setJson(node: Json | undefined, path: Path, value: Json | undefined): Json | undefined {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  if (typeof key === "number") {
    const list = Array.isArray(node) ? [...node] : [];
    const next = setJson(list[key], rest, value);
    if (next === undefined) list.splice(key, 1);
    else list[key] = next;
    return list;
  }
  const object = isObject(node) ? node : {};
  const next = setJson(object[key], rest, value);
  // Spreading keeps an existing key in its place, so edited fields don't jump to the end.
  if (next !== undefined) return { ...object, [key]: next };
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

/** Immutably set a value. `undefined` removes the key, or the array element. */
export function setIn(root: JsonObject, path: Path, value: Json | undefined): JsonObject {
  const next = setJson(root, path, value);
  return isObject(next) ? next : {};
}

/** `path` starts with "metadata" or "spec". */
export function updateDraft(draft: Draft, path: Path, value: Json | undefined): Draft {
  const [section, ...rest] = path;
  if (section === "metadata") return { ...draft, metadata: setIn(draft.metadata, rest, value) };
  if (section === "spec") return { ...draft, spec: setIn(draft.spec, rest, value) };
  throw new Error(`Draft paths start with metadata or spec, not ${String(section)}`);
}

/** Empty optional fields are removed rather than stored as "". */
export function optional(value: string): string | undefined {
  return value === "" ? undefined : value;
}

/** JSON with sorted keys, for comparing drafts regardless of key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isObject(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
}

// --- new drafts and the server section -------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export function newDraft(kind: CatalogKind): Draft {
  if (kind === "skill")
    return { metadata: { name: "" }, spec: { source: { type: "placeholder", notes: "" } } };
  return { metadata: { name: "" }, spec: { server: { url: "", exposure: "codemode" } } };
}

export function serverOf(draft: Draft): JsonObject | undefined {
  const server = draft.spec.server;
  return isObject(server) ? server : undefined;
}

export function serverMode(draft: Draft): ServerMode {
  const server = serverOf(draft);
  if (!server) return "none";
  return "command" in server ? "stdio" : "http";
}

const COMMON_SERVER_FIELDS = ["description", "exposure", "timeout"] as const;

/** Switch transport, keeping the description, exposure and timeout. */
export function setServerMode(draft: Draft, mode: ServerMode): Draft {
  if (mode === serverMode(draft)) return draft;
  if (mode === "none") return updateDraft(draft, ["spec", "server"], undefined);
  const previous = serverOf(draft) ?? {};
  const server: JsonObject = { exposure: "codemode" };
  for (const field of COMMON_SERVER_FIELDS) {
    const value = previous[field];
    if (value !== undefined) server[field] = value;
  }
  if (mode === "stdio") server.command = "";
  else server.url = "";
  return updateDraft(draft, ["spec", "server"], server);
}

// --- names, ids and labels -------------------------------------------------------------

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return SLUG_PATTERN.test(slug) ? slug : "";
}

export function displayName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const ACRONYMS = new Set(["api", "url", "id", "mcp", "aws", "sso", "jwt", "pat", "ssh", "http"]);

/** `REDASH_API_KEY` becomes "Redash API key". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  const label = words.join(" ");
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Value";
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(id)) id = `input_${id}`.replace(/_+$/, "");
  id = id.slice(0, 40).replace(/_+$/, "") || "value";
  if (!taken.has(id)) return id;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id.slice(0, 40 - String(suffix).length - 1)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Tags are typed as a comma-separated list; the backend stores lowercase slugs. */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);
}

// --- turning a value into a user input -------------------------------------------------

const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE/i;
const PLACEHOLDER =
  /^(<[^>]*>|your[-_ ].*|x{3,}|\*{3,}|changeme|change[-_ ]me|replace[-_ ]?me|todo|\.\.\.)$/i;
const AUTH_SCHEME = /^(Bearer|Token|Basic)\s+(.+)$/i;

export type InputTarget =
  { group: "env" | "headers"; name: string } | { group: "args"; index: number };

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

export function isReference(value: string): boolean {
  return value.includes("${");
}

function argumentName(argument: string): string {
  const equals = argument.indexOf("=");
  const raw =
    equals >= 0 ? argument.slice(0, equals).replace(/^-+/, "") : argument.replace(/[<>]/g, "");
  return raw.trim() || "value";
}

function targetName(server: JsonObject, target: InputTarget): string {
  return target.group === "args"
    ? argumentName(textList(server.args)[target.index] ?? "")
    : target.name;
}

function inputType(name: string): InputType {
  if (CREDENTIAL_NAME.test(name)) return "secret";
  if (/url/i.test(name)) return "url";
  return "text";
}

/**
 * Replace a literal value with `${input:<id>}`, declare the input, and place its field
 * in the setup steps. The rest of the value is kept: `Bearer x` becomes
 * `Bearer ${input:id}` and `--token=x` becomes `--token=${input:id}`.
 */
export function makeInput(draft: Draft, target: InputTarget): Draft {
  const server = serverOf(draft) ?? {};
  const inputs = objectList(draft.spec.inputs);
  const name = targetName(server, target);
  const id = uniqueId(name, new Set(inputs.map((input) => text(input.id))));
  const reference = `\${input:${id}}`;

  let next = draft;
  if (target.group === "args") {
    const args = textList(server.args);
    const argument = args[target.index] ?? "";
    const equals = argument.indexOf("=");
    args[target.index] = equals >= 0 ? `${argument.slice(0, equals + 1)}${reference}` : reference;
    next = updateDraft(next, ["spec", "server", "args"], args);
  } else {
    const current = text(getIn(server, [target.group, target.name]));
    const scheme = AUTH_SCHEME.exec(current);
    const value = scheme ? `${scheme[1]} ${reference}` : reference;
    next = updateDraft(next, ["spec", "server", target.group, target.name], value);
  }

  const input: JsonObject = { id, label: humanize(name), type: inputType(name), required: true };
  next = updateDraft(next, ["spec", "inputs"], [...jsonList(next.spec.inputs), input]);
  return updateDraft(
    next,
    ["spec", "steps"],
    [...jsonList(next.spec.steps), { type: "input", input: id }],
  );
}

/** Whether a literal env/header value should probably be a per-user input. */
export function inputSuggestion(name: string, value: string): "placeholder" | "credential" | null {
  if (isReference(value)) return null;
  const credential = AUTH_SCHEME.exec(value)?.[2] ?? value;
  if (isPlaceholder(credential)) return "placeholder";
  return CREDENTIAL_NAME.test(name) ? "credential" : null;
}

// --- after-install sign-in step for OAuth servers ----------------------------------------

export function hasAuthStep(draft: Draft): boolean {
  return objectList(draft.spec.afterInstall).some((block) => text(block.text).includes("/mcp"));
}

export function addAuthStep(draft: Draft): Draft {
  if (hasAuthStep(draft)) return draft;
  const name = text(draft.metadata.name).trim() || "this server";
  const step = {
    type: "text",
    text: `Run \`/reload\` in Pi, then run \`/mcp\` to authenticate with ${name}.`,
  };
  return updateDraft(draft, ["spec", "afterInstall"], [...jsonList(draft.spec.afterInstall), step]);
}

// --- Import from mcp.json --------------------------------------------------------------

export interface SnippetServer {
  name: string | null;
  definition: JsonObject;
}

export type ParsedSnippet = { ok: true; servers: SnippetServer[] } | { ok: false; error: string };

export interface ImportFinding {
  /** Stable key for the dialog's checkboxes, for example `env:REDASH_API_KEY`. */
  key: string;
  target: InputTarget;
  field: string;
  reason: "placeholder" | "credential";
}

export interface ImportResult {
  draft: Draft;
  slug: string;
  imported: string[];
  ignored: string[];
  findings: ImportFinding[];
  suggestAuthStep: boolean;
}

const MAX_SNIPPET_LENGTH = 64 * 1024;

function looksLikeServer(value: unknown): value is JsonObject {
  return isObject(value) && (typeof value.command === "string" || typeof value.url === "string");
}

/** Versions of the pasted text to try: as-is, wrapped in braces, and without trailing commas or braces. */
function candidates(source: string): string[] {
  const relaxed = (value: string) => value.replace(/,(\s*[}\]])/g, "$1");
  let body = source.trim().replace(/,\s*$/, "");
  const list = [body, relaxed(body)];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    list.push(`{${body}}`, relaxed(`{${body}}`));
    if (!body.endsWith("}")) break;
    body = body.slice(0, -1).trim().replace(/,\s*$/, "");
  }
  return list;
}

function serversIn(parsed: unknown): SnippetServer[] {
  if (!isObject(parsed)) return [];
  if (isObject(parsed.mcpServers))
    return Object.entries(parsed.mcpServers)
      .filter((entry): entry is [string, JsonObject] => looksLikeServer(entry[1]))
      .map(([name, definition]) => ({ name, definition }));
  if (looksLikeServer(parsed)) return [{ name: null, definition: parsed }];
  return Object.entries(parsed)
    .filter((entry): entry is [string, JsonObject] => looksLikeServer(entry[1]))
    .map(([name, definition]) => ({ name, definition }));
}

/**
 * Accepts a whole mcp.json file, a `"name": { ... }` entry (with or without the
 * surrounding braces or a trailing comma), several entries, or a bare definition.
 */
export function parseSnippet(source: string): ParsedSnippet {
  if (!source.trim()) return { ok: false, error: "Paste an mcp.json file or one server entry." };
  if (source.length > MAX_SNIPPET_LENGTH)
    return { ok: false, error: "This is too long to import. Paste one server entry." };
  let parsedAny = false;
  for (const candidate of candidates(source)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    parsedAny = true;
    const servers = serversIn(parsed);
    if (servers.length > 0) return { ok: true, servers };
  }
  return {
    ok: false,
    error: parsedAny
      ? "No server found. A server entry has a command or a url."
      : 'This isn\'t valid JSON. Paste an mcp.json file, or one entry like "name": { ... }.',
  };
}

function importServerFields(definition: JsonObject): { server: JsonObject; ignored: string[] } {
  const server: JsonObject = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(definition)) {
    // Empty strings are simply absent, not worth reporting as skipped.
    if (value === "") continue;
    const strings = (entry: Json) => typeof entry === "string";
    const accepted =
      (["command", "cwd", "url", "description"].includes(key) && typeof value === "string") ||
      (key === "args" && Array.isArray(value) && value.every(strings)) ||
      ((key === "env" || key === "headers") &&
        isObject(value) &&
        Object.values(value).every(strings)) ||
      (key === "timeout" && typeof value === "number" && value > 0) ||
      (key === "type" && (value === "stdio" || value === "http" || value === "streamable-http")) ||
      (key === "exposure" && (EXPOSURES as readonly Json[]).includes(value));
    if (accepted) server[key] = value;
    else ignored.push(key);
  }
  server.exposure ??= "codemode";
  return { server, ignored };
}

function findInputs(server: JsonObject): ImportFinding[] {
  const findings: ImportFinding[] = [];
  for (const group of ["env", "headers"] as const) {
    for (const [name, value] of textEntries(server[group])) {
      const reason = inputSuggestion(name, value);
      if (reason)
        findings.push({
          key: `${group}:${name}`,
          target: { group, name },
          field: group === "env" ? name : `${name} header`,
          reason,
        });
    }
  }
  textList(server.args).forEach((argument, index) => {
    const equals = argument.indexOf("=");
    const value = equals >= 0 ? argument.slice(equals + 1) : argument;
    if (!isReference(argument) && isPlaceholder(value))
      findings.push({
        key: `args:${index}`,
        target: { group: "args", index },
        field: `argument ${index + 1}`,
        reason: "placeholder",
      });
  });
  return findings;
}

function describeImport(server: JsonObject): string[] {
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  const imported: string[] = [];
  if (typeof server.command === "string") imported.push(`command ${server.command}`);
  if (Array.isArray(server.args)) imported.push(count(server.args.length, "argument"));
  if (isObject(server.env))
    imported.push(count(Object.keys(server.env).length, "environment variable"));
  if (typeof server.cwd === "string") imported.push("working directory");
  if (typeof server.url === "string") imported.push("URL");
  if (isObject(server.headers)) imported.push(count(Object.keys(server.headers).length, "header"));
  if (typeof server.type === "string") imported.push(`type ${server.type}`);
  if (typeof server.timeout === "number") imported.push(`timeout ${server.timeout}s`);
  if (typeof server.description === "string") imported.push("description");
  imported.push(`exposure ${text(server.exposure)}`);
  return imported;
}

/**
 * Turn one pasted server into the draft's server section. Inputs, steps and existing
 * metadata are kept; the name and summary are filled in only when empty.
 */
export function importServer(snippet: SnippetServer, current: Draft): ImportResult {
  const { server, ignored } = importServerFields(snippet.definition);
  let draft: Draft = { metadata: { ...current.metadata }, spec: { ...current.spec, server } };
  if (!text(draft.metadata.name).trim() && snippet.name)
    draft = updateDraft(draft, ["metadata", "name"], displayName(snippet.name));
  const description = text(server.description);
  if (!text(draft.metadata.summary).trim() && description && !/[\r\n]/.test(description))
    draft = updateDraft(draft, ["metadata", "summary"], description.slice(0, 300));
  return {
    draft,
    slug: snippet.name ? slugify(snippet.name) : "",
    imported: describeImport(server),
    ignored,
    findings: findInputs(server),
    suggestAuthStep:
      typeof server.url === "string" &&
      !isObject(server.headers) &&
      objectList(draft.spec.inputs).length === 0 &&
      !hasAuthStep(draft),
  };
}

/** Apply the dialog's choices: convert the checked findings and optionally add the sign-in step. */
export function applyImport(
  result: ImportResult,
  convert: ReadonlySet<string>,
  authStep: boolean,
): Draft {
  let draft = result.draft;
  for (const finding of result.findings)
    if (convert.has(finding.key)) draft = makeInput(draft, finding.target);
  return authStep ? addAuthStep(draft) : draft;
}

// --- step blocks -------------------------------------------------------------------------

export const BLOCK_LABELS: Record<BlockType, string> = {
  text: "Text",
  command: "Command",
  link: "Link",
  callout: "Callout",
  input: "Input field",
  check: "Prerequisite check",
  confirm: "Confirmation",
};

export function newBlock(
  type: BlockType,
  inputIds: readonly string[],
  prerequisiteIds: readonly string[],
  takenConfirmIds: ReadonlySet<string>,
): JsonObject {
  switch (type) {
    case "text":
      return { type, text: "" };
    case "command":
      return { type, command: "" };
    case "link":
      return { type, label: "", url: "https://" };
    case "callout":
      return { type, tone: "info", text: "" };
    case "input":
      return { type, input: inputIds[0] ?? "" };
    case "check":
      return { type, prerequisite: prerequisiteIds[0] ?? "" };
    case "confirm":
      return { type, id: uniqueId("done", takenConfirmIds), label: "" };
  }
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]*)\]\((https:\/\/[^)\s]+)\)/g;

/** The text block syntax the hub supports: `code`, **bold** and [label](https://...). */
export function inlineTokens(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) tokens.push({ kind: "text", text: source.slice(last, index) });
    if (match[1] !== undefined) tokens.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "bold", text: match[2] });
    else tokens.push({ kind: "link", text: match[3] || (match[4] ?? ""), href: match[4] ?? "" });
    last = index + match[0].length;
  }
  if (last < source.length) tokens.push({ kind: "text", text: source.slice(last) });
  return tokens;
}

// --- labels and problems -----------------------------------------------------------------

export const TIER_LABELS: Record<InstallTier, string> = {
  one_click: "One-click",
  guided: "Guided",
  manual: "Manual",
};

export const STATUS_LABELS: Record<CatalogStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

/** `one` and `many` are for use mid-sentence. */
export const KIND_LABELS: Record<CatalogKind, { one: string; many: string }> = {
  mcp: { one: "MCP server", many: "MCP servers" },
  skill: { one: "skill", many: "skills" },
};

const PATH_LABELS: readonly (readonly [string, string])[] = [
  ["metadata.name", "Name"],
  ["metadata.summary", "Summary"],
  ["metadata.tags", "Tags"],
  ["metadata.docsUrl", "Docs link"],
  ["metadata.icon", "Icon"],
  ["metadata", "Details"],
  ["spec.server.command", "Command"],
  ["spec.server.args", "Arguments"],
  ["spec.server.env", "Environment"],
  ["spec.server.cwd", "Working directory"],
  ["spec.server.url", "URL"],
  ["spec.server.headers", "Headers"],
  ["spec.server.type", "Transport type"],
  ["spec.server.timeout", "Timeout"],
  ["spec.server.description", "Server description"],
  ["spec.server.exposure", "Exposure"],
  ["spec.server", "Server"],
  ["spec.inputs", "Inputs"],
  ["spec.prerequisites", "Prerequisites"],
  ["spec.steps", "Setup steps"],
  ["spec.afterInstall", "After install"],
  ["spec.source", "Source"],
  ["spec", "Setup"],
];

/** "spec.inputs.1.label" becomes "Inputs › #2 › label". */
export function describePath(path: string): string {
  const match = PATH_LABELS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`));
  if (!match) return path;
  const [prefix, label] = match;
  const rest = path
    .slice(prefix.length)
    .split(".")
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? `#${Number(part) + 1}` : part))
    .filter((part, index, parts) => part !== parts[index - 1]);
  return [label, ...rest].join(" › ");
}

export function issuesUnder(issues: readonly CatalogIssue[], prefix: string): CatalogIssue[] {
  return issues.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
}

/** Checks the backend cannot run yet: it refuses to validate a draft without a name. */
export function localIssues(draft: Draft): CatalogIssue[] {
  return text(draft.metadata.name).trim()
    ? []
    : [{ path: "metadata.name", message: "Add a name." }];
}
