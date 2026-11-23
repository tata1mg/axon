// biome-ignore-all lint/suspicious/noTemplateCurlyInString: catalog templates use literal ${input:<id>} references.
import { describe, expect, test } from "bun:test";

import {
  extractInputs,
  fingerprint,
  inputPositions,
  mergeEntry,
  renderServer,
  validateInputValues,
} from "../src/hub/catalog-install.ts";
import { type McpInput, serverTemplateSchema } from "../src/hub/catalog-schema.ts";
import { HubError } from "../src/hub/errors.ts";

const redash = serverTemplateSchema.parse({
  command: "npx",
  args: ["-y", "@suthio/redash-mcp@1.0.4"],
  env: { REDASH_URL: "https://redash.1mg.com/", REDASH_API_KEY: "${input:api_key}" },
  description: "Query Redash.",
});
const apiKey: McpInput = {
  id: "api_key",
  label: "Redash API key",
  type: "secret",
  required: true,
  help: [],
};

function hubError(run: () => unknown): HubError {
  try {
    run();
  } catch (error) {
    if (error instanceof HubError) return error;
    throw error;
  }
  throw new Error("expected a HubError");
}

describe("renderServer", () => {
  test("fills inputs and keeps catalog fields, defaulting exposure to codemode", () => {
    expect(renderServer(redash, new Map([["api_key", "sk-123"]]))).toEqual({
      command: "npx",
      args: ["-y", "@suthio/redash-mcp@1.0.4"],
      env: { REDASH_URL: "https://redash.1mg.com/", REDASH_API_KEY: "sk-123" },
      description: "Query Redash.",
      exposure: "codemode",
    });
  });

  test("encodes URL inputs and refuses a changed origin", () => {
    const template = serverTemplateSchema.parse({
      type: "streamable-http",
      url: "https://mcp.example.com/${input:team}/mcp?key=${input:key}",
      headers: { Authorization: "Bearer ${input:token}" },
      timeout: 50,
    });
    const values = new Map([
      ["team", "a b/c"],
      ["key", "x&y=z"],
      ["token", "t0k"],
    ]);
    expect(renderServer(template, values)).toEqual({
      type: "streamable-http",
      url: "https://mcp.example.com/a%20b%2Fc/mcp?key=x%26y%3Dz",
      headers: { Authorization: "Bearer t0k" },
      timeout: 50,
      exposure: "codemode",
    });
    const host = serverTemplateSchema.parse({ url: "https://${input:host}.example.com/mcp" });
    expect(hubError(() => renderServer(host, new Map([["host", "evil.com/x"]]))).status).toBe(400);
  });

  test("an optional input left empty drops values that are only that input", () => {
    const template = serverTemplateSchema.parse({
      command: "tool",
      args: ["--profile", "${input:profile}", "--flag=${input:flag}"],
      env: { TEAM: "${input:team}", PREFIXED: "team-${input:team}" },
      cwd: "${input:dir}",
    });
    expect(
      renderServer(
        template,
        new Map([
          ["profile", ""],
          ["flag", ""],
          ["team", ""],
          ["dir", ""],
        ]),
      ),
    ).toEqual({
      command: "tool",
      args: ["--profile", "--flag="],
      env: { PREFIXED: "team-" },
      exposure: "codemode",
    });
  });

  test("never puts an input into the command", () => {
    const template = serverTemplateSchema.parse({ command: "${input:binary}" });
    expect(hubError(() => renderServer(template, new Map([["binary", "/bin/sh"]]))).status).toBe(
      422,
    );
  });
});

describe("extractInputs", () => {
  test("reads back exact, embedded and URL-encoded values", () => {
    const template = serverTemplateSchema.parse({
      url: "https://mcp.example.com/${input:team}/mcp",
      headers: { Authorization: "Bearer ${input:token}", "X-Static": "fixed" },
    });
    const entry = renderServer(
      template,
      new Map([
        ["team", "a b"],
        ["token", "secret value"],
      ]),
    );
    expect(Object.fromEntries(extractInputs(template, entry))).toEqual({
      team: "a b",
      token: "secret value",
    });
  });

  test("ignores values the user edited into another shape", () => {
    const template = serverTemplateSchema.parse({
      url: "https://x.example",
      headers: { A: "Bearer ${input:t}" },
    });
    expect(
      extractInputs(template, { url: "https://x.example", headers: { A: "Token abc" } }).size,
    ).toBe(0);
  });
});

describe("validateInputValues", () => {
  const inputs: McpInput[] = [
    apiKey,
    { id: "base", label: "Base URL", type: "url", required: false, help: [] },
    { id: "team", label: "Team", type: "text", required: false, pattern: "[a-z]+", help: [] },
  ];

  test("trims, requires, and keeps a stored value when left blank", () => {
    expect(Object.fromEntries(validateInputValues(inputs, { api_key: "  sk  " }))).toEqual({
      api_key: "sk",
      base: "",
      team: "",
    });
    expect(
      validateInputValues(inputs, { api_key: "" }, new Map([["api_key", "stored"]])).get("api_key"),
    ).toBe("stored");
    expect(hubError(() => validateInputValues(inputs, {})).message).toBe("Enter Redash API key.");
  });

  test("rejects unknown inputs and bad values without echoing them", () => {
    for (const [submitted, message] of [
      [{ api_key: "x", other: "secret-value" }, "unknown input"],
      [{ api_key: "line1\nsecret-value" }, "single line"],
      [{ api_key: "x", base: "ftp://secret-value" }, "http:// or https://"],
      [{ api_key: "x", team: "Secret-Value" }, "expected format"],
      [{ api_key: "x".repeat(5000) }, "too long"],
    ] as const) {
      const error = hubError(() => validateInputValues(inputs, submitted));
      expect(error.status).toBe(400);
      expect(error.message).toContain(message);
      expect(error.message).not.toContain("ecret");
    }
  });
});

describe("fingerprint and mergeEntry", () => {
  const positions = inputPositions(redash);

  test("input positions are listed for the fingerprint", () => {
    expect(positions).toEqual(["env.REDASH_API_KEY"]);
  });

  test("ignores input values, enabled and the user's own fields, but not catalog fields", () => {
    const one = mergeEntry(renderServer(redash, new Map([["api_key", "a"]])), undefined);
    const two = {
      ...mergeEntry(renderServer(redash, new Map([["api_key", "b"]])), undefined),
      enabled: false,
      oauth: {},
    };
    expect(fingerprint(one, positions)).toBe(fingerprint(two, positions));
    expect(fingerprint({ ...one, args: ["-y", "other"] }, positions)).not.toBe(
      fingerprint(one, positions),
    );
  });

  test("an update replaces catalog fields and keeps the user's fields and disabled state", () => {
    const previous = { command: "old", args: ["x"], enabled: false, oauth: { clientId: "mine" } };
    expect(mergeEntry({ command: "npx", exposure: "codemode" }, previous)).toEqual({
      oauth: { clientId: "mine" },
      command: "npx",
      exposure: "codemode",
      enabled: false,
    });
    expect(mergeEntry({ url: "https://x" }, undefined)).toEqual({
      url: "https://x",
      enabled: true,
    });
  });
});
