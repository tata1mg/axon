// Pure MCP editor rules, shared by the React UI and unit tests. No DOM access here.

export type Transport = "stdio" | "http";
export type ServerState = "enabled" | "disabled" | "invalid";
export type Filter = "all" | ServerState;
export type Exposure = "codemode" | "deferred" | "direct" | "hidden";

/** Mirrors `McpServerView` from ../../mcp-store.ts: values of args, cwd, env and headers never arrive. */
export interface McpServer {
  readonly name: string;
  readonly transport: Transport | "unknown";
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly requiresExecutionApproval: boolean;
  readonly description: string;
  readonly exposure: string;
  readonly command?: string;
  readonly url?: string;
  readonly hasStoredUrl: boolean;
  readonly argumentCount: number;
  readonly environmentKeys: readonly string[];
  readonly headerKeys: readonly string[];
  /** Installed from the organization catalog. */
  readonly catalog?: { readonly slug: string; readonly revision: number };
}

export interface McpCatalog {
  readonly revision: string;
  readonly configPath: string;
  readonly servers: readonly McpServer[];
}

export const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_KEY_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const EXPOSURES: Record<Exposure, { label: string; description: string }> = {
  codemode: {
    label: "Code mode",
    description: "Pi discovers this server’s tools when it needs them.",
  },
  deferred: {
    label: "Tool search",
    description: "Tools stay out of the prompt until Pi finds them with tool search.",
  },
  direct: {
    label: "Direct",
    description: "Every tool is always visible to the model. Uses more context.",
  },
  hidden: {
    label: "Hidden",
    description: "The server stays configured, but its tools can’t be called.",
  },
};

export function isExposure(value: string): value is Exposure {
  return Object.hasOwn(EXPOSURES, value);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function serverState(server: McpServer): ServerState {
  if (!server.editable) return "invalid";
  return server.enabled ? "enabled" : "disabled";
}

export function summarizeKeys(label: string, keys: readonly string[]): string {
  const shown = keys.slice(0, 3).join(", ");
  return `${label}: ${shown}${keys.length > 3 ? ` +${keys.length - 3}` : ""}`;
}

export function serverFacts(server: McpServer): string[] {
  const facts: string[] = [];
  if (server.argumentCount) facts.push(plural(server.argumentCount, "argument"));
  if (server.environmentKeys.length) facts.push(summarizeKeys("Env", server.environmentKeys));
  if (server.headerKeys.length) facts.push(summarizeKeys("Headers", server.headerKeys));
  if (server.editable && server.exposure !== "codemode")
    facts.push(
      `Tools: ${isExposure(server.exposure) ? EXPOSURES[server.exposure].label : server.exposure}`,
    );
  return facts;
}

export function matchesQuery(server: McpServer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${server.name} ${server.description} ${server.url ?? ""} ${server.command ?? ""}`
    .toLowerCase()
    .includes(needle);
}

/* ---------- Errors ---------- */

export type FieldTarget =
  | { readonly field: "name" | "url" | "command" }
  | { readonly kv: KvSection; readonly row: number; readonly part: "key" | "value" };

export class FieldError extends Error {
  constructor(
    message: string,
    readonly target: FieldTarget,
  ) {
    super(message);
  }
}

/* ---------- Command line ---------- */

export interface SplitResult {
  readonly tokens: string[];
  readonly error?: string;
}

/** Splits a pasted command the way a POSIX shell would, without supporting shell features. */
export function splitCommand(text: string): SplitResult {
  const tokens: { value: string; unquoted: string }[] = [];
  let current = "";
  let unquoted = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const push = () => {
    if (started) tokens.push({ value: current, unquoted });
    current = "";
    unquoted = "";
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        current += next;
        index += 1;
      } else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && next !== undefined && /[\s'"\\]/.test(next)) {
      current += next;
      index += 1;
      started = true;
    } else if (/\s/.test(char)) push();
    else {
      current += char;
      unquoted += char;
      started = true;
    }
  }
  if (quote) return { tokens: [], error: "Close the open quote in the command." };
  push();
  if (tokens.some((token) => /[|&;<>`]|\$\(/.test(token.unquoted)))
    return {
      tokens: [],
      error:
        "Pipes, redirects, &&, and ; need a shell, and this command runs without one. Put them in a script and run that instead.",
    };
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(tokens[0]?.unquoted ?? "");
  if (assignment)
    return {
      tokens: [],
      error: `Add ${assignment[1]} under Environment variables instead of setting it in the command.`,
    };
  return { tokens: tokens.map((token) => token.value) };
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface CommandRead {
  readonly tokens: string[];
  readonly error?: string;
  /** Hidden stored arguments that stay in the config. */
  readonly keptArgs: number;
  /** Hidden stored arguments that a full command replaces. */
  readonly replacedArgs: number;
  readonly changes: { command?: string; args?: string[] };
}

/** Edit keeps hidden stored arguments unless a full command replaces them or they're cleared. */
export function readCommand(
  input: string,
  server: McpServer | undefined,
  clearArgs: boolean,
): CommandRead {
  const text = input.trim();
  const storedArgs = server?.argumentCount ?? 0;
  if (server?.command !== undefined && text === shellQuote(server.command))
    return {
      tokens: [server.command],
      keptArgs: clearArgs ? 0 : storedArgs,
      replacedArgs: 0,
      changes: clearArgs && storedArgs ? { args: [] } : {},
    };
  const empty = { tokens: [], keptArgs: 0, replacedArgs: 0, changes: {} };
  if (!text) return { ...empty, error: "Enter the command that starts the server." };
  const { tokens, error } = splitCommand(text);
  if (error) return { ...empty, error };
  const [command, ...args] = tokens as [string, ...string[]];
  if (args.length === 0 && storedArgs && !clearArgs)
    return { tokens, keptArgs: storedArgs, replacedArgs: 0, changes: { command } };
  return { tokens, keptArgs: 0, replacedArgs: storedArgs, changes: { command, args } };
}

/* ---------- Key/value rows ---------- */

export type KvSection = "env" | "headers";

export interface KvRow {
  readonly id: number;
  /** Set for keys already in the config; their values are never sent to the page. */
  readonly stored?: string;
  readonly key: string;
  readonly value: string;
  readonly removed: boolean;
}

export interface KvRules {
  readonly section: KvSection;
  readonly noun: string;
  readonly pattern: RegExp;
  readonly patternError: string;
  readonly caseInsensitive: boolean;
}

export const ENV_RULES: KvRules = {
  section: "env",
  noun: "variable",
  pattern: ENV_KEY_PATTERN,
  patternError:
    "Variable names use letters, digits, and underscores, and can’t start with a digit.",
  caseInsensitive: false,
};

export const HEADER_RULES: KvRules = {
  section: "headers",
  noun: "header",
  pattern: HEADER_KEY_PATTERN,
  patternError: "Header names can’t contain spaces, colons, or other separators.",
  caseInsensitive: true,
};

let nextRowId = 1;

export function newRow(stored?: string): KvRow {
  const id = nextRowId++;
  return stored === undefined
    ? { id, key: "", value: "", removed: false }
    : { id, stored, key: stored, value: "", removed: false };
}

/** Values that will be stored, for spotting `!command` credential helpers. */
export function keptValues(rows: readonly KvRow[]): string[] {
  return rows.filter((row) => !row.removed).map((row) => row.value);
}

export function rowsTouched(rows: readonly KvRow[]): boolean {
  return rows.some(
    (row) => row.removed || row.value !== "" || (row.stored === undefined && row.key.trim() !== ""),
  );
}

/** Partial update: strings add or replace keys, null removes a stored key. */
export function collectRows(
  rows: readonly KvRow[],
  rules: KvRules,
): Record<string, string | null> | undefined {
  const normalize = (key: string) => (rules.caseInsensitive ? key.toLowerCase() : key);
  const updates: Record<string, string | null> = Object.create(null);
  const seen = new Map<string, string>();
  for (const row of rows) if (row.stored !== undefined) seen.set(normalize(row.stored), row.stored);
  for (const row of rows) {
    if (row.stored !== undefined) {
      if (row.removed) updates[row.stored] = null;
      else if (row.value !== "") updates[row.stored] = row.value;
      continue;
    }
    const name = row.key.trim();
    const at = (part: "key" | "value") => ({ kv: rules.section, row: row.id, part }) as const;
    if (!name && !row.value) continue;
    if (!name)
      throw new FieldError(`Enter a ${rules.noun} name, or remove the empty row.`, at("key"));
    if (name.length > 256 || !rules.pattern.test(name))
      throw new FieldError(rules.patternError, at("key"));
    const existing = seen.get(normalize(name));
    if (existing !== undefined)
      throw new FieldError(
        `${existing} is already listed. Enter its new value in that row instead.`,
        at("key"),
      );
    if (row.value === "") throw new FieldError(`Enter a value for ${name}.`, at("value"));
    seen.set(normalize(name), name);
    updates[name] = row.value;
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

/* ---------- Whole form ---------- */

export interface EditorForm {
  readonly transport: Transport;
  readonly name: string;
  readonly url: string;
  readonly command: string;
  readonly clearArgs: boolean;
  readonly cwd: string;
  readonly description: string;
  readonly exposure: Exposure;
  readonly enabled: boolean;
  readonly env: readonly KvRow[];
  readonly headers: readonly KvRow[];
}

export function initialForm(server?: McpServer): EditorForm {
  return {
    transport: server?.transport === "stdio" ? "stdio" : "http",
    name: server?.name ?? "",
    url: server?.url ?? "",
    command: server?.command === undefined ? "" : shellQuote(server.command),
    clearArgs: false,
    cwd: "",
    description: server?.description ?? "",
    exposure: server && isExposure(server.exposure) ? server.exposure : "codemode",
    enabled: true,
    env: (server?.environmentKeys ?? []).map((key) => newRow(key)),
    headers: (server?.headerKeys ?? []).map((key) => newRow(key)),
  };
}

/** Env shows for local servers, headers for remote ones, and either whenever keys are stored. */
export function visibleSections(form: EditorForm): Record<KvSection, boolean> {
  const stdio = form.transport === "stdio";
  return {
    env: stdio || form.env.some((row) => row.stored !== undefined),
    headers: !stdio || form.headers.some((row) => row.stored !== undefined),
  };
}

function hasHelper(form: EditorForm): boolean {
  return [...keptValues(form.env), ...keptValues(form.headers)].some((value) =>
    value.trimStart().startsWith("!"),
  );
}

/** Mirrors the server: execution approval is needed when a risky config gains risky changes. */
export function needsTrust(form: EditorForm, server: McpServer | undefined): boolean {
  const stdio = form.transport === "stdio";
  const risky = stdio || hasHelper(form) || Boolean(server?.requiresExecutionApproval);
  if (!risky) return false;
  if (!server) return true;
  if (stdio) {
    const command = readCommand(form.command, server, form.clearArgs);
    if (command.error || Object.keys(command.changes).length > 0) return true;
    if (form.cwd.trim()) return true;
  } else {
    const url = form.url.trim();
    if (url && url !== server.url) return true;
  }
  return rowsTouched(form.env) || rowsTouched(form.headers);
}

/** Backtick-delimited text for the trust note above the save button. */
export function trustMessage(form: EditorForm, server: McpServer | undefined): string {
  const stdio = form.transport === "stdio";
  const parts: string[] = [];
  if (stdio) {
    const executable = readCommand(form.command, server, form.clearArgs).tokens[0];
    parts.push(
      executable
        ? `Pi runs \`${executable}\` with your permissions when it loads this server.`
        : "Pi runs this command with your permissions when it loads this server.",
    );
  }
  if (hasHelper(form) || (!stdio && server?.requiresExecutionApproval))
    parts.push("Values starting with `!` run as commands to fetch credentials.");
  parts.push("Save only if you trust it.");
  return parts.join(" ");
}

export type Changes = Record<string, unknown>;

/**
 * Builds the create definition, or only the changed fields when editing.
 * Throws `FieldError` pointing at the first invalid input.
 */
export function buildChanges(
  form: EditorForm,
  server: McpServer | undefined,
  servers: readonly McpServer[],
): Changes {
  const fields: Changes = {};
  if (!server) {
    const name = form.name.trim();
    const at = { field: "name" } as const;
    if (!name) throw new FieldError("Give the server a name.", at);
    if (!NAME_PATTERN.test(name))
      throw new FieldError("Use only letters, numbers, hyphens, and underscores.", at);
    const alias = name.replaceAll("-", "_");
    const clash = servers.find((item) => item.name.replaceAll("-", "_") === alias);
    if (clash)
      throw new FieldError(
        clash.name === name
          ? `${name} already exists.`
          : `${clash.name} already exists, and Pi treats - and _ as the same.`,
        at,
      );
  }
  const description = form.description.trim();
  if (server ? description !== server.description : description)
    fields["description"] = description;
  const initialExposure = server && isExposure(server.exposure) ? server.exposure : "codemode";
  if (!server || form.exposure !== initialExposure) fields["exposure"] = form.exposure;
  if (!server) fields["enabled"] = form.enabled;

  if (form.transport === "stdio") {
    const command = readCommand(form.command, server, form.clearArgs);
    if (command.error) throw new FieldError(command.error, { field: "command" });
    Object.assign(fields, command.changes);
    const cwd = form.cwd.trim();
    if (cwd) fields["cwd"] = cwd;
  } else {
    const url = form.url.trim();
    const at = { field: "url" } as const;
    if (url) {
      let valid = false;
      try {
        valid = ["http:", "https:"].includes(new URL(url).protocol);
      } catch {}
      if (!valid) throw new FieldError("Enter a full http:// or https:// URL.", at);
      if (url !== server?.url) fields["url"] = url;
    } else if (!server?.hasStoredUrl) throw new FieldError("Enter the server’s URL.", at);
  }
  const sections = visibleSections(form);
  if (sections.env) {
    const env = collectRows(form.env, ENV_RULES);
    if (env) fields["env"] = env;
  }
  if (sections.headers) {
    const headers = collectRows(form.headers, HEADER_RULES);
    if (headers) fields["headers"] = headers;
  }
  return fields;
}
