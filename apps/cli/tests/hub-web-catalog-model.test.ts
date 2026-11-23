// biome-ignore-all lint/suspicious/noTemplateCurlyInString: catalog templates use literal ${input:<id>} references.
import { describe, expect, test } from "bun:test";
import { cardFor, enabledKinds, sections } from "../src/hub/web/catalog/kinds.ts";
import {
  actionFor,
  blocker,
  inlineTokens,
  type LocalState,
  type McpItem,
  reviewRows,
  type SkillItem,
  safeHref,
  stateTag,
  unplacedInputs,
  unplacedPrerequisites,
} from "../src/hub/web/catalog/model.ts";

function redash(local: LocalState = { state: "not_installed" }): McpItem {
  return {
    kind: "mcp",
    slug: "redash",
    revision: 2,
    tier: "guided",
    featured: false,
    publishedAt: "2026-11-18T10:00:00Z",
    metadata: { name: "Redash", summary: "Query Redash.", tags: [] },
    local,
    prerequisiteStatus: [{ id: "node", found: false }],
    spec: {
      server: {
        command: "npx",
        args: ["-y", "@suthio/redash-mcp@1.0.4"],
        env: { REDASH_URL: "https://redash.1mg.com/", REDASH_API_KEY: "${input:api_key}" },
        exposure: "codemode",
      },
      inputs: [
        { id: "api_key", label: "Redash API key", type: "secret", required: true, help: [] },
        { id: "team", label: "Team", type: "text", required: false, help: [] },
      ],
      prerequisites: [
        { id: "node", label: "Node.js", detect: { executable: "npx" }, help: [] },
        { id: "vpn", label: "VPN", help: [] },
      ],
      steps: [
        { type: "check", prerequisite: "vpn" },
        { type: "input", input: "api_key" },
        { type: "confirm", id: "access", label: "I have Redash access" },
      ],
      afterInstall: [],
    },
  };
}

const installed = (state: "installed" | "update_available" | "changed_locally"): LocalState => ({
  state,
  name: "redash",
  installedRevision: 1,
  changedLocally: state === "changed_locally",
});

describe("card actions and tags", () => {
  test("follow the local state", () => {
    expect(actionFor(redash())).toEqual({ action: "install", label: "Install" });
    expect(actionFor(redash({ state: "name_in_use", name: "redash" })).action).toBe("install_as");
    expect(actionFor(redash(installed("update_available"))).action).toBe("update");
    expect(actionFor(redash(installed("changed_locally"))).action).toBe("reset");
    expect(actionFor(redash(installed("installed"))).action).toBe("details");
    const { server: _server, ...steps } = redash().spec;
    const manual: McpItem = { ...redash(), spec: steps };
    expect(actionFor(manual).action).toBe("steps");
    expect(stateTag(redash())).toBeNull();
    expect(stateTag(redash(installed("installed")))).toEqual({ label: "Installed", tone: "ok" });
  });
});

describe("blocker", () => {
  const form = { values: {}, confirmed: new Set<string>(), name: "redash-catalog" };

  test("requires inputs and confirmations for a new install", () => {
    expect(blocker(redash(), form)).toBe("Enter Redash API key.");
    expect(blocker(redash(), { ...form, values: { api_key: "x" } })).toBe(
      "Tick “I have Redash access”.",
    );
    expect(
      blocker(redash(), { ...form, values: { api_key: "x" }, confirmed: new Set(["access"]) }),
    ).toBeNull();
  });

  test("lets an update keep stored values, and needs a valid name when the slug is taken", () => {
    expect(
      blocker(redash(installed("update_available")), { ...form, confirmed: new Set(["access"]) }),
    ).toBeNull();
    const taken = redash({ state: "name_in_use", name: "redash" });
    const ready = { values: { api_key: "x" }, confirmed: new Set(["access"]) };
    expect(blocker(taken, { ...ready, name: "bad name" })).toContain("server name");
    expect(blocker(taken, { ...ready, name: "redash-org" })).toBeNull();
  });
});

describe("review and layout", () => {
  test("masks secrets, names missing inputs, and says when a stored value is kept", () => {
    const rows = (item: McpItem, values: Record<string, string>) =>
      Object.fromEntries(reviewRows(item, values).map((row) => [row.label, row.value]));
    expect(rows(redash(), { api_key: "sk-123" })).toEqual({
      Runs: "npx -y @suthio/redash-mcp@1.0.4",
      "env REDASH_URL": "https://redash.1mg.com/",
      "env REDASH_API_KEY": "••••••",
      Exposure: "codemode",
    });
    expect(rows(redash(), {})["env REDASH_API_KEY"]).toBe("‹Redash API key›");
    expect(rows(redash(installed("update_available")), {})["env REDASH_API_KEY"]).toBe(
      "‹stored value›",
    );
  });

  test("inputs and prerequisites without a step are listed separately", () => {
    expect(unplacedInputs(redash()).map((input) => input.id)).toEqual(["team"]);
    expect(unplacedPrerequisites(redash()).map((entry) => entry.id)).toEqual(["node"]);
  });
});

describe("text", () => {
  test("only code, bold and https links are formatted", () => {
    expect(
      inlineTokens("Run `/reload`, **then** [sign in](https://app.last9.io) or [x](http://x)"),
    ).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "/reload" },
      { kind: "text", text: ", " },
      { kind: "bold", text: "then" },
      { kind: "text", text: " " },
      { kind: "link", text: "sign in", href: "https://app.last9.io" },
      { kind: "text", text: " or [x](http://x)" },
    ]);
    expect(safeHref("https://redash.1mg.com/users/me")).toBe("https://redash.1mg.com/users/me");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("http://insecure.example")).toBeUndefined();
  });
});

describe("Discover kinds", () => {
  const skill: SkillItem = {
    kind: "skill",
    slug: "pdf-tools",
    revision: 1,
    tier: null,
    featured: false,
    publishedAt: "2026-11-18T10:00:00Z",
    metadata: { name: "PDF tools", summary: "", tags: [] },
    local: { state: "not_installed" },
    prerequisiteStatus: [],
  };

  test("turn on from session features, in registry order", () => {
    expect(enabledKinds({ catalog: true }).map(({ kind }) => kind)).toEqual(["mcp"]);
    expect(enabledKinds({ catalog: true, skills: true }).map(({ kind }) => kind)).toEqual([
      "mcp",
      "skill",
    ]);
    expect(enabledKinds({ skills: false })).toEqual([]);
  });

  test("group items by kind; All drops empty kinds, a single kind keeps its empty state", () => {
    const kinds = enabledKinds({ catalog: true, skills: true });
    const items = [skill, redash()];
    expect(
      sections(items, kinds, "all").map(({ info, items }) => [info.kind, items.length]),
    ).toEqual([
      ["mcp", 1],
      ["skill", 1],
    ]);
    expect(sections([redash()], kinds, "all").map(({ info }) => info.kind)).toEqual(["mcp"]);
    expect(
      sections([redash()], kinds, "skill").map(({ info, items }) => [info.kind, items.length]),
    ).toEqual([["skill", 0]]);
  });

  test("cards: MCP follows its local state, skills can't install yet", () => {
    expect(cardFor(redash()).action).toEqual({ label: "Install", primary: true, disabled: false });
    expect(cardFor(redash(installed("installed")))).toEqual({
      action: { label: "Details", primary: false, disabled: false },
      tag: { label: "Installed", tone: "ok" },
    });
    expect(cardFor(skill)).toEqual({
      action: { label: "Install", primary: false, disabled: true },
      tag: { label: "Coming soon", tone: "muted" },
    });
  });
});
