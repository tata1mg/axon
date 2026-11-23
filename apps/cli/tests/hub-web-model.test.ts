import { describe, expect, test } from "bun:test";
import {
  buildChanges,
  collectRows,
  type EditorForm,
  ENV_RULES,
  FieldError,
  HEADER_RULES,
  initialForm,
  type KvRow,
  type McpServer,
  needsTrust,
  newRow,
  readCommand,
  serverFacts,
  shellQuote,
  splitCommand,
  trustMessage,
  visibleSections,
} from "../src/hub/web/mcp/model.ts";

/** Overrides may set optional fields to undefined to drop them. */
type Overrides = { [K in keyof McpServer]?: McpServer[K] | undefined };

function server(overrides: Overrides = {}): McpServer {
  return {
    name: "files",
    transport: "stdio",
    enabled: true,
    editable: true,
    requiresExecutionApproval: true,
    description: "Local files",
    exposure: "codemode",
    command: "npx",
    hasStoredUrl: false,
    argumentCount: 3,
    environmentKeys: [],
    headerKeys: [],
    ...overrides,
  } as McpServer;
}

const remote = (overrides: Overrides = {}) =>
  server({
    name: "linear",
    transport: "http",
    requiresExecutionApproval: false,
    command: undefined,
    url: "https://mcp.linear.app/mcp",
    argumentCount: 0,
    ...overrides,
  });

function form(base: McpServer | undefined, patch: Partial<EditorForm> = {}): EditorForm {
  return { ...initialForm(base), ...patch };
}

function fieldError(run: () => unknown): FieldError {
  try {
    run();
  } catch (error) {
    if (error instanceof FieldError) return error;
    throw error;
  }
  throw new Error("expected a FieldError");
}

describe("splitCommand", () => {
  test("splits like a POSIX shell, keeping quoted spaces and escapes", () => {
    expect(splitCommand(`npx -y @mcp/fs "/Users/me/My Docs" it\\'s '' a\\ b`).tokens).toEqual([
      "npx",
      "-y",
      "@mcp/fs",
      "/Users/me/My Docs",
      "it's",
      "",
      "a b",
    ]);
  });

  test("allows shell characters inside quotes", () => {
    expect(splitCommand(`node -e "a|b && c"`).tokens).toEqual(["node", "-e", "a|b && c"]);
  });

  test.each([
    ["npx thing | tee out", "Pipes"],
    ["a && b", "Pipes"],
    ["cat < in", "Pipes"],
    ["echo $(whoami)", "Pipes"],
    ["FOO=1 npx thing", "Add FOO under Environment variables"],
    [`npx "unclosed`, "Close the open quote"],
  ])("rejects %p", (text, message) => {
    const result = splitCommand(text);
    expect(result.tokens).toEqual([]);
    expect(result.error).toContain(message);
  });

  test("shellQuote round-trips through splitCommand", () => {
    for (const value of ["plain", "/path with space", "it's", "", "$HOME"])
      expect(splitCommand(shellQuote(value)).tokens).toEqual([value]);
  });
});

describe("readCommand", () => {
  const stored = server();

  test("an unchanged executable keeps hidden stored arguments", () => {
    expect(readCommand("npx", stored, false)).toMatchObject({ keptArgs: 3, changes: {} });
  });

  test("Clear on an unchanged executable sends empty args", () => {
    expect(readCommand("npx", stored, true)).toMatchObject({ keptArgs: 0, changes: { args: [] } });
  });

  test("a new executable alone changes only the command", () => {
    expect(readCommand("bunx", stored, false)).toMatchObject({
      keptArgs: 3,
      changes: { command: "bunx" },
    });
    expect(readCommand("bunx", stored, false).changes).not.toHaveProperty("args");
  });

  test("a full command replaces the stored arguments", () => {
    expect(readCommand("bunx pkg --flag", stored, false)).toMatchObject({
      replacedArgs: 3,
      changes: { command: "bunx", args: ["pkg", "--flag"] },
    });
  });

  test("an empty command is an error", () => {
    expect(readCommand("  ", undefined, false).error).toContain("Enter the command");
  });
});

describe("collectRows", () => {
  const rows = (...items: KvRow[]) => items;

  test("removed stored keys become null, typed values replace, blank keeps", () => {
    const removed = { ...newRow("OLD"), removed: true };
    const replaced = { ...newRow("TOKEN"), value: "new-token" };
    const kept = newRow("KEEP");
    const added = { ...newRow(), key: " API_KEY ", value: "x" };
    expect(collectRows(rows(removed, replaced, kept, added), ENV_RULES)).toEqual(
      Object.assign(Object.create(null), { OLD: null, TOKEN: "new-token", API_KEY: "x" }),
    );
  });

  test("returns undefined when nothing changed, ignoring empty new rows", () => {
    expect(collectRows(rows(newRow("KEEP"), newRow()), ENV_RULES)).toBeUndefined();
  });

  test("points errors at the offending row and part", () => {
    const row = { ...newRow(), key: "1BAD", value: "x" };
    expect(fieldError(() => collectRows([row], ENV_RULES)).target).toEqual({
      kv: "env",
      row: row.id,
      part: "key",
    });
    const missing = { ...newRow(), key: "GOOD" };
    expect(fieldError(() => collectRows([missing], ENV_RULES)).target).toMatchObject({
      part: "value",
    });
  });

  test("header names collide case-insensitively with stored keys", () => {
    const duplicate = { ...newRow(), key: "authorization", value: "Bearer x" };
    expect(
      fieldError(() => collectRows([newRow("Authorization"), duplicate], HEADER_RULES)).message,
    ).toContain("Authorization is already listed");
  });
});

describe("buildChanges", () => {
  test("a description-only edit sends just the description and needs no trust", () => {
    const base = server();
    const edited = form(base, { description: "Warehouse, read-only." });
    expect(buildChanges(edited, base, [base])).toEqual({ description: "Warehouse, read-only." });
    expect(needsTrust(edited, base)).toBe(false);
  });

  test("an untouched edit has no changes", () => {
    const base = remote({ headerKeys: ["Authorization"] });
    expect(buildChanges(form(base), base, [base])).toEqual({});
  });

  test("adding a local server sends the full definition and needs trust", () => {
    const added = form(undefined, {
      transport: "stdio",
      name: "files",
      command: "npx -y @mcp/fs",
      env: [{ ...newRow(), key: "API_KEY", value: "api-key" }],
    });
    const fields = buildChanges(added, undefined, []);
    expect(fields).toMatchObject({
      command: "npx",
      args: ["-y", "@mcp/fs"],
      exposure: "codemode",
      enabled: true,
    });
    expect({ ...(fields["env"] as object) }).toEqual({ API_KEY: "api-key" });
    expect(needsTrust(added, undefined)).toBe(true);
    expect(trustMessage(added, undefined)).toContain("`npx`");
  });

  test("rejects names that clash once hyphens become underscores", () => {
    const existing = remote({ name: "postgres-readonly" });
    const added = form(undefined, { name: "postgres_readonly", url: "https://x.example/mcp" });
    const error = fieldError(() => buildChanges(added, undefined, [existing]));
    expect(error.target).toEqual({ field: "name" });
    expect(error.message).toContain("Pi treats - and _ as the same");
  });

  test("a stored private URL can stay blank, but a new server needs a valid URL", () => {
    const base = remote({ url: undefined, hasStoredUrl: true });
    expect(buildChanges(form(base), base, [base])).toEqual({});
    const added = form(undefined, { name: "x", url: "ftp://nope" });
    expect(fieldError(() => buildChanges(added, undefined, [])).target).toEqual({ field: "url" });
  });

  test("a !command helper on a remote server needs trust", () => {
    const base = remote();
    const edited = form(base, { headers: [{ ...newRow(), key: "X-Token", value: "!pass x" }] });
    expect(needsTrust(edited, base)).toBe(true);
    expect(trustMessage(edited, base)).toContain("`!`");
  });

  test("env rows from another transport are not sent", () => {
    const added = form(undefined, {
      name: "web",
      url: "https://x.example/mcp",
      env: [{ ...newRow(), key: "A", value: "b" }],
    });
    expect(visibleSections(added)).toEqual({ env: false, headers: true });
    expect(buildChanges(added, undefined, [])).not.toHaveProperty("env");
  });
});

test("serverFacts summarizes hidden configuration without values", () => {
  expect(
    serverFacts(
      server({ environmentKeys: ["A", "B", "C", "D"], headerKeys: [], exposure: "direct" }),
    ),
  ).toEqual(["3 arguments", "Env: A, B, C +1", "Tools: Direct"]);
});
