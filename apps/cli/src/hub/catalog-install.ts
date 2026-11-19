/**
 * Turning a published catalog entry into a Pi `mcp.json` entry, without I/O.
 *
 * Only the hub fills in `${input:<id>}`, and only in args, env and header values, cwd and
 * the URL (encoded, and the URL's origin may not change). Input values never leave this
 * machine. The fingerprint that detects local edits covers the catalog-managed fields with
 * every input position masked, so it never depends on (or reveals) what the user typed.
 */
import { createHash } from "node:crypto";

import { hasControlCharacters, type McpInput, type ServerTemplate } from "./catalog-schema.ts";
import { HubError } from "./errors.ts";

type JsonObject = Record<string, unknown>;

export const MAX_INPUT_LENGTH = 4096;
const REFERENCE = /\$\{input:([a-z][a-z0-9_]{0,39})\}/g;
const EXACT_REFERENCE = /^\$\{input:([a-z][a-z0-9_]{0,39})\}$/;
const MARKER = "${input:";
const MASK = "<input>";

/** Entry fields the catalog writes. Everything else (enabled, oauth, ...) stays the user's. */
export const MANAGED_FIELDS = [
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "timeout",
  "description",
  "exposure",
] as const;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every templated string with its position, for example `env.API_KEY` or `args.1`. */
function templatedValues(template: ServerTemplate): [string, string][] {
  const values: [string, string][] = [];
  template.args?.forEach((value, index) => {
    values.push([`args.${index}`, value]);
  });
  for (const [name, value] of Object.entries(template.env ?? {}))
    values.push([`env.${name}`, value]);
  for (const [name, value] of Object.entries(template.headers ?? {}))
    values.push([`headers.${name}`, value]);
  if (template.cwd !== undefined) values.push(["cwd", template.cwd]);
  if (template.url !== undefined) values.push(["url", template.url]);
  return values;
}

/** Positions that hold user input. Stored with the install to fingerprint the entry later. */
export function inputPositions(template: ServerTemplate): string[] {
  return templatedValues(template)
    .filter(([, value]) => value.includes(MARKER))
    .map(([position]) => position);
}

function valueAt(entry: JsonObject, position: string): unknown {
  const [field, key] = position.split(/\.(.*)/s, 2);
  const container = entry[field as string];
  if (key === undefined) return container;
  if (field === "args") return Array.isArray(container) ? container[Number(key)] : undefined;
  return isObject(container) ? container[key] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read back what was filled in at install time, so an update can keep a stored value the
 * user leaves blank. Only exact template matches count: a value the user edited by hand
 * is not reused.
 */
export function extractInputs(template: ServerTemplate, entry: JsonObject): Map<string, string> {
  const found = new Map<string, string>();
  for (const [position, raw] of templatedValues(template)) {
    if (!raw.includes(MARKER)) continue;
    const current = valueAt(entry, position);
    if (typeof current !== "string") continue;
    const ids: string[] = [];
    let source = "^";
    let last = 0;
    for (const match of raw.matchAll(REFERENCE)) {
      source += `${escapeRegExp(raw.slice(last, match.index))}([\\s\\S]*?)`;
      ids.push(match[1] as string);
      last = match.index + match[0].length;
    }
    const groups = new RegExp(`${source}${escapeRegExp(raw.slice(last))}$`).exec(current);
    if (!groups) continue;
    ids.forEach((id, index) => {
      let value = groups[index + 1] ?? "";
      if (position === "url") {
        try {
          value = decodeURIComponent(value);
        } catch {
          return;
        }
      }
      if (!found.has(id)) found.set(id, value);
    });
  }
  return found;
}

/**
 * Check the submitted values against the entry's inputs. A blank value keeps `kept` (the
 * value already stored) when there is one. Messages name the input, never its value.
 */
export function validateInputValues(
  inputs: readonly McpInput[],
  submitted: Readonly<Record<string, string>>,
  kept: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const declared = new Set(inputs.map((input) => input.id));
  for (const id of Object.keys(submitted))
    if (!declared.has(id)) throw new HubError(400, "The install request has an unknown input.");
  const values = new Map<string, string>();
  for (const input of inputs) {
    let value = (submitted[input.id] ?? "").trim();
    if (value === "") value = kept.get(input.id) ?? "";
    if (value === "") {
      if (input.required) throw new HubError(400, `Enter ${input.label}.`);
      values.set(input.id, "");
      continue;
    }
    if (value.length > MAX_INPUT_LENGTH) throw new HubError(400, `${input.label} is too long.`);
    if (hasControlCharacters(value))
      throw new HubError(400, `${input.label} must be a single line.`);
    if (input.type === "url" && !isHttpUrl(value))
      throw new HubError(400, `${input.label} must be an http:// or https:// URL.`);
    if (input.pattern !== undefined && !matchesPattern(input.pattern, value))
      throw new HubError(400, `${input.label} doesn't have the expected format.`);
    values.set(input.id, value);
  }
  return values;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Like an HTML `pattern`: the whole value must match. A pattern JS can't compile is skipped. */
function matchesPattern(pattern: string, value: string): boolean {
  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    return true;
  }
  return expression.test(value);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Build the mcp.json entry (without `enabled`) from the template and validated values. */
export function renderServer(
  template: ServerTemplate,
  values: ReadonlyMap<string, string>,
): JsonObject {
  const fill = (raw: string, encode: (value: string) => string = (value) => value) =>
    raw.replace(REFERENCE, (_match, id: string) => encode(values.get(id) ?? ""));
  // An optional input left empty drops a value that is nothing but that input.
  const omitted = (raw: string) => {
    const id = EXACT_REFERENCE.exec(raw)?.[1];
    return id !== undefined && (values.get(id) ?? "") === "";
  };

  const entry: JsonObject = {};
  if (template.type !== undefined) entry["type"] = template.type;
  if (template.command !== undefined) {
    if (template.command.includes(MARKER))
      throw new HubError(422, "This catalog entry can't be installed: its command uses an input.");
    entry["command"] = template.command;
  }
  if (template.args !== undefined)
    entry["args"] = template.args.filter((arg) => !omitted(arg)).map((arg) => fill(arg));
  for (const group of ["env", "headers"] as const) {
    const source = template[group];
    if (source === undefined) continue;
    entry[group] = Object.fromEntries(
      Object.entries(source)
        .filter(([, raw]) => !omitted(raw))
        .map(([name, raw]) => [name, fill(raw)]),
    );
  }
  if (template.cwd !== undefined && !omitted(template.cwd)) entry["cwd"] = fill(template.cwd);
  if (template.url !== undefined) {
    const expected = originOf(template.url.replace(REFERENCE, "x"));
    if (expected === undefined)
      throw new HubError(422, "This catalog entry has an invalid URL. Ask an admin to fix it.");
    const url = fill(template.url, encodeURIComponent);
    if (originOf(url) !== expected)
      throw new HubError(
        400,
        "An input changed the server's address. Check the values you entered.",
      );
    entry["url"] = url;
  }
  if (template.timeout !== undefined) entry["timeout"] = template.timeout;
  if (template.description) entry["description"] = template.description;
  entry["exposure"] = template.exposure;
  return entry;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

/** Hash of the catalog-managed fields with input positions masked. */
export function fingerprint(entry: JsonObject, positions: readonly string[]): string {
  const managed: JsonObject = {};
  for (const field of MANAGED_FIELDS) if (entry[field] !== undefined) managed[field] = entry[field];
  const masked = structuredClone(managed);
  for (const position of positions) {
    const [field, key] = position.split(/\.(.*)/s, 2) as [string, string | undefined];
    if (key === undefined) {
      if (masked[field] !== undefined) masked[field] = MASK;
    } else if (field === "args" && Array.isArray(masked["args"])) {
      if (Number(key) < masked["args"].length) masked["args"][Number(key)] = MASK;
    } else {
      const container = masked[field];
      if (isObject(container) && Object.hasOwn(container, key)) container[key] = MASK;
    }
  }
  return createHash("sha256")
    .update(JSON.stringify(stable(masked)))
    .digest("hex");
}

/** The entry to write: catalog fields replace the old ones; the user's own fields stay. */
export function mergeEntry(rendered: JsonObject, previous: JsonObject | undefined): JsonObject {
  if (previous === undefined) return { ...rendered, enabled: true };
  const kept = Object.fromEntries(
    Object.entries(previous).filter(
      ([key]) => !(MANAGED_FIELDS as readonly string[]).includes(key),
    ),
  );
  // Updating never re-enables a server the user turned off.
  return { ...kept, ...rendered, enabled: previous["enabled"] !== false };
}
