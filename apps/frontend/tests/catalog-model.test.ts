import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addAuthStep,
  applyImport,
  describePath,
  displayName,
  humanize,
  importServer,
  inlineTokens,
  inputSuggestion,
  makeInput,
  moveItem,
  newDraft,
  parseSnippet,
  sameJson,
  serverMode,
  setIn,
  setServerMode,
  slugify,
  uniqueId,
  updateDraft,
  type SnippetServer,
} from "../src/admin/catalog/model.ts";
import type { Draft } from "../src/admin/catalog/types.ts";

// The snippets the team shared, pasted as-is (fragments, a stray brace, a trailing comma).
const REDASH_SNIPPET = `{
  "mcpServers": {
    "redash": {
      "command": "npx",
      "args": [
         "-y",
         "@suthio/redash-mcp"
      ],
      "env": {
        "REDASH_API_KEY": "your-api-key",
        "REDASH_URL": "https://redash.1mg.com/"
      }
    }
  }
}`;

const LAST9_SNIPPET = ` "last9": {
      "enabled": false,
      "type": "streamable-http",
      "url": "https://app.last9.io/api/v4/organizations/tata1mg/mcp",
      "timeout": 50,
      "description": "",
      "exposure": "codemode"
    }
  }`;

const ATLASSIAN_SNIPPET = `    "atlassian": {
      "enabled": false,
      "url": "https://mcp.atlassian.com/v2/mcp?tools=all",
      "exposure": "codemode",
      "description": "Search and manage Atlassian work across Jira, Confluence, Bitbucket, and other connected products."
    },`;

function only(source: string): SnippetServer {
  const parsed = parseSnippet(source);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.servers.length, 1);
  return parsed.servers[0] as SnippetServer;
}

describe("parseSnippet", () => {
  test("accepts the shared snippets in the shapes they were pasted", () => {
    assert.equal(only(REDASH_SNIPPET).name, "redash");
    assert.equal(only(LAST9_SNIPPET).name, "last9");
    assert.equal(only(ATLASSIAN_SNIPPET).name, "atlassian");
  });

  test("accepts a bare definition and several entries", () => {
    assert.deepEqual(only('{ "url": "https://example.com/mcp" }'), {
      name: null,
      definition: { url: "https://example.com/mcp" },
    });
    const parsed = parseSnippet('"a": { "command": "x" }, "b": { "url": "https://b.example" }');
    assert.ok(parsed.ok);
    assert.deepEqual(
      parsed.servers.map((server) => server.name),
      ["a", "b"],
    );
  });

  test("explains what is wrong", () => {
    for (const [source, message] of [
      ["", "Paste an mcp.json file"],
      ["not json at all", "isn't valid JSON"],
      ['{ "mcpServers": { "x": { "enabled": true } } }', "No server found"],
      ["x".repeat(70_000), "too long"],
    ] as const) {
      const parsed = parseSnippet(source);
      assert.equal(parsed.ok, false);
      assert.match(parsed.ok ? "" : parsed.error, new RegExp(message));
    }
  });
});

describe("importServer", () => {
  test("Redash: a placeholder key becomes a secret input with a field in the steps", () => {
    const result = importServer(only(REDASH_SNIPPET), newDraft("mcp"));
    assert.equal(result.slug, "redash");
    assert.equal(result.draft.metadata.name, "Redash");
    assert.deepEqual(result.ignored, []);
    assert.deepEqual(result.imported, [
      "command npx",
      "2 arguments",
      "2 environment variables",
      "exposure codemode",
    ]);
    assert.deepEqual(
      result.findings.map(({ key, reason }) => [key, reason]),
      [["env:REDASH_API_KEY", "placeholder"]],
    );
    assert.equal(result.suggestAuthStep, false);

    const draft = applyImport(result, new Set(["env:REDASH_API_KEY"]), false);
    assert.deepEqual(draft.spec.server, {
      command: "npx",
      args: ["-y", "@suthio/redash-mcp"],
      env: { REDASH_API_KEY: "${input:redash_api_key}", REDASH_URL: "https://redash.1mg.com/" },
      exposure: "codemode",
    });
    assert.deepEqual(draft.spec.inputs, [
      { id: "redash_api_key", label: "Redash API key", type: "secret", required: true },
    ]);
    assert.deepEqual(draft.spec.steps, [{ type: "input", input: "redash_api_key" }]);
  });

  test("Last9: drops enabled and empty fields, keeps type and timeout, offers the sign-in step", () => {
    const result = importServer(only(LAST9_SNIPPET), newDraft("mcp"));
    assert.deepEqual(result.ignored, ["enabled"]);
    assert.deepEqual(result.draft.spec.server, {
      type: "streamable-http",
      url: "https://app.last9.io/api/v4/organizations/tata1mg/mcp",
      timeout: 50,
      exposure: "codemode",
    });
    assert.equal(result.suggestAuthStep, true);
    const draft = applyImport(result, new Set(), true);
    assert.deepEqual(draft.spec.afterInstall, [
      { type: "text", text: "Run `/reload` in Pi, then run `/mcp` to authenticate with Last9." },
    ]);
  });

  test("Atlassian: the description also fills an empty summary", () => {
    const result = importServer(only(ATLASSIAN_SNIPPET), newDraft("mcp"));
    assert.equal(result.slug, "atlassian");
    assert.match(String(result.draft.metadata.summary), /^Search and manage Atlassian work/);
    assert.equal(result.findings.length, 0);
  });

  test("keeps an existing name, summary, inputs and steps", () => {
    const current: Draft = {
      metadata: { name: "Data warehouse", summary: "Ours" },
      spec: { inputs: [{ id: "token", label: "Token" }], steps: [{ type: "text", text: "Hi" }] },
    };
    const result = importServer(only(REDASH_SNIPPET), current);
    assert.equal(result.draft.metadata.name, "Data warehouse");
    assert.equal(result.draft.metadata.summary, "Ours");
    assert.deepEqual(result.draft.spec.steps, [{ type: "text", text: "Hi" }]);
    assert.equal(result.suggestAuthStep, false);
  });

  test("finds credentials in headers and placeholders in arguments", () => {
    const result = importServer(
      only(
        '"x": { "url": "https://x.example/mcp", "headers": { "Authorization": "Bearer abc123", "X-Team": "core" } }',
      ),
      newDraft("mcp"),
    );
    assert.deepEqual(
      result.findings.map(({ key, reason }) => [key, reason]),
      [["headers:Authorization", "credential"]],
    );
    const draft = applyImport(result, new Set(["headers:Authorization"]), false);
    assert.deepEqual(draft.spec.server && (draft.spec.server as Record<string, unknown>).headers, {
      Authorization: "Bearer ${input:authorization}",
      "X-Team": "core",
    });

    const args = importServer(
      only('{ "command": "tool", "args": ["--api-key=<your key>", "<path>", "-y"] }'),
      newDraft("mcp"),
    );
    assert.deepEqual(
      args.findings.map((finding) => finding.key),
      ["args:0", "args:1"],
    );
    const converted = applyImport(args, new Set(["args:0", "args:1"]), false);
    assert.deepEqual((converted.spec.server as Record<string, unknown>).args, [
      "--api-key=${input:api_key}",
      "${input:path}",
      "-y",
    ]);
    assert.deepEqual(
      (converted.spec.inputs as Record<string, unknown>[]).map((input) => input.type),
      ["secret", "text"],
    );
  });
});

describe("makeInput", () => {
  test("gives repeated names unique ids", () => {
    let draft: Draft = {
      metadata: { name: "x" },
      spec: { server: { command: "x", env: { TOKEN: "a", token: "b" } } },
    };
    draft = makeInput(draft, { group: "env", name: "TOKEN" });
    draft = makeInput(draft, { group: "env", name: "token" });
    assert.deepEqual((draft.spec.server as Record<string, unknown>).env, {
      TOKEN: "${input:token}",
      token: "${input:token_2}",
    });
  });
});

describe("helpers", () => {
  test("names, slugs and ids", () => {
    assert.equal(slugify("My_Server Prod"), "my-server-prod");
    assert.equal(slugify("x"), "");
    assert.equal(slugify("--Last9--"), "last9");
    assert.equal(displayName("my_server-x"), "My Server X");
    assert.equal(humanize("REDASH_API_KEY"), "Redash API key");
    assert.equal(humanize("X-Api-Key"), "X API key");
    assert.equal(humanize("accessToken"), "Access token");
    assert.equal(uniqueId("9lives", new Set()), "input_9lives");
    assert.equal(uniqueId("token", new Set(["token", "token_2"])), "token_3");
  });

  test("input suggestions mirror the backend warnings", () => {
    assert.equal(inputSuggestion("REDASH_API_KEY", "your-api-key"), "placeholder");
    assert.equal(inputSuggestion("Authorization", "Bearer <token>"), "placeholder");
    assert.equal(inputSuggestion("GITHUB_TOKEN", "ghp_live"), "credential");
    assert.equal(inputSuggestion("GITHUB_TOKEN", "${input:token}"), null);
    assert.equal(inputSuggestion("REDASH_URL", "https://redash.1mg.com/"), null);
  });

  test("setIn and updateDraft never mutate, and undefined removes", () => {
    const root = { a: { b: [1, 2, 3] } };
    assert.deepEqual(setIn(root, ["a", "b", 1], undefined), { a: { b: [1, 3] } });
    assert.deepEqual(setIn(root, ["a", "c"], "x"), { a: { b: [1, 2, 3], c: "x" } });
    assert.deepEqual(root, { a: { b: [1, 2, 3] } });
    // Editing a key keeps its position; removing it keeps the others in order.
    const env = { FIRST: "1", SECOND: "2", THIRD: "3" };
    assert.deepEqual(Object.keys(setIn(env, ["FIRST"], "x")), ["FIRST", "SECOND", "THIRD"]);
    assert.deepEqual(Object.keys(setIn(env, ["SECOND"], undefined)), ["FIRST", "THIRD"]);
    const draft = newDraft("mcp");
    assert.deepEqual(updateDraft(draft, ["spec", "server", "url"], undefined).spec, {
      server: { exposure: "codemode" },
    });
    assert.throws(() => updateDraft(draft, ["other"], 1));
  });

  test("switching transport keeps description, exposure and timeout", () => {
    const http: Draft = {
      metadata: { name: "x" },
      spec: {
        server: {
          url: "https://x",
          headers: { A: "b" },
          description: "d",
          timeout: 5,
          exposure: "direct",
        },
      },
    };
    assert.equal(serverMode(http), "http");
    const stdio = setServerMode(http, "stdio");
    assert.deepEqual(stdio.spec.server, {
      command: "",
      description: "d",
      timeout: 5,
      exposure: "direct",
    });
    assert.equal(serverMode(setServerMode(stdio, "none")), "none");
  });

  test("addAuthStep is idempotent", () => {
    const once = addAuthStep({ metadata: { name: "Atlassian" }, spec: {} });
    assert.equal(addAuthStep(once), once);
  });

  test("inline tokens", () => {
    assert.deepEqual(
      inlineTokens("Run `/reload`, then **sign in** at [Last9](https://app.last9.io)."),
      [
        { kind: "text", text: "Run " },
        { kind: "code", text: "/reload" },
        { kind: "text", text: ", then " },
        { kind: "bold", text: "sign in" },
        { kind: "text", text: " at " },
        { kind: "link", text: "Last9", href: "https://app.last9.io" },
        { kind: "text", text: "." },
      ],
    );
    assert.deepEqual(inlineTokens("[insecure](http://x.example)"), [
      { kind: "text", text: "[insecure](http://x.example)" },
    ]);
  });

  test("problem paths read like the form", () => {
    assert.equal(describePath("spec.server.env.REDASH_API_KEY"), "Environment › REDASH_API_KEY");
    assert.equal(describePath("spec.inputs.1.label"), "Inputs › #2 › label");
    assert.equal(describePath("spec.steps.0.text.text"), "Setup steps › #1 › text");
    assert.equal(describePath("metadata.summary"), "Summary");
    assert.equal(describePath("elsewhere"), "elsewhere");
  });

  test("sameJson ignores key order and moveItem stays in bounds", () => {
    assert.ok(sameJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
    assert.ok(!sameJson({ a: [1, 2] }, { a: [2, 1] }));
    assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
    assert.deepEqual(moveItem(["a", "b"], 0, -1), ["a", "b"]);
  });
});
