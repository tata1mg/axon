import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LocalHub, startLocalHub } from "../src/hub/server.ts";
import { listLocalSkills, type SkillsView, skillLocations } from "../src/hub/skills.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const BASE = "/_axon/hub";
let root: string;
let piSkills: string;
let agentsSkills: string;
let locations: ReturnType<typeof skillLocations>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-hub-skills-"));
  locations = skillLocations(join(root, ".axon", "pi"), root);
  piSkills = locations[0].path;
  agentsSkills = locations[1].path;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skill(directory: string, frontmatter: string, body = "# Body\nsecret body text\n") {
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

test("lists both user folders in Pi's order and reports missing folders", async () => {
  await skill(join(agentsSkills, "paseo"), "name: paseo\ndescription: Manage agents.");
  await skill(join(piSkills, "pdf-tools"), "name: pdf-tools\ndescription: >\n  Extract PDFs.");
  const view = await listLocalSkills(locations);
  expect(view.locations.map(({ id, exists }) => [id, exists])).toEqual([
    ["axon", true],
    ["agents", true],
  ]);
  expect(view.skills).toEqual([
    {
      name: "pdf-tools",
      description: "Extract PDFs.",
      path: join(piSkills, "pdf-tools", "SKILL.md"),
      location: "axon",
      status: "ok",
      problems: [],
      modelInvocation: true,
    },
    {
      name: "paseo",
      description: "Manage agents.",
      path: join(agentsSkills, "paseo", "SKILL.md"),
      location: "agents",
      status: "ok",
      problems: [],
      modelInvocation: true,
    },
  ]);
  expect(JSON.stringify(view)).not.toContain("secret body text");

  await rm(agentsSkills, { recursive: true });
  expect((await listLocalSkills(locations)).locations[1]).toMatchObject({ exists: false });
});

test("follows Pi's discovery rules for nesting, standalone files and skipped entries", async () => {
  await skill(join(piSkills, "group", "nested"), "description: Nested skill.");
  // A skill root is not searched further.
  await skill(join(piSkills, "group", "nested", "inner"), "name: inner\ndescription: Hidden.");
  await Bun.write(join(piSkills, "standalone.md"), "---\ndescription: Root file.\n---\n");
  await Bun.write(join(piSkills, "notes.md"), "# Not a skill: no description\n");
  await Bun.write(join(piSkills, "group", "deep.md"), "---\ndescription: Not at the root.\n---\n");
  await skill(join(piSkills, ".hidden"), "name: hidden\ndescription: Dot folder.");
  await skill(join(piSkills, "node_modules", "dep"), "name: dep\ndescription: Dependency.");
  await Bun.write(join(agentsSkills, "root.md"), "---\ndescription: Root file in agents.\n---\n");
  await mkdir(join(agentsSkills, "extra"), { recursive: true });
  await Bun.write(join(agentsSkills, "extra", "loose.md"), "---\ndescription: Loose.\n---\n");

  const view = await listLocalSkills(locations);
  expect(view.skills.map(({ name, location }) => `${location}:${name}`)).toEqual([
    "axon:nested",
    "axon:standalone",
    "agents:loose",
  ]);
});

test("reports skills Pi skips or overrides, and model-invocation opt-outs", async () => {
  await skill(join(piSkills, "review"), "name: review\ndescription: Mine.");
  await skill(join(agentsSkills, "review"), "name: review\ndescription: Shared.");
  await skill(join(piSkills, "broken"), "name: broken");
  await skill(join(piSkills, "bad-yaml"), "name: [unclosed");
  await skill(
    join(piSkills, "Manual"),
    "description: Manual only.\ndisable-model-invocation: true",
  );
  await symlink(join(piSkills, "review"), join(piSkills, "review-link"));

  const view: SkillsView = await listLocalSkills(locations);
  const byPath = (path: string) => view.skills.find((entry) => entry.path === path);
  expect(byPath(join(agentsSkills, "review", "SKILL.md"))).toMatchObject({
    status: "shadowed",
    problems: [
      `Pi loads the skill with this name from ${join(piSkills, "review", "SKILL.md")} instead.`,
    ],
  });
  expect(byPath(join(piSkills, "broken", "SKILL.md"))).toMatchObject({
    status: "not_loaded",
    problems: ["It has no description, so Pi doesn’t load it. Add one to the frontmatter."],
  });
  expect(byPath(join(piSkills, "bad-yaml", "SKILL.md"))).toMatchObject({
    name: "bad-yaml",
    status: "not_loaded",
  });
  expect(byPath(join(piSkills, "Manual", "SKILL.md"))).toMatchObject({
    name: "Manual",
    status: "ok",
    modelInvocation: false,
    problems: ["The name should use only lowercase letters, digits and hyphens."],
  });
  // The symlinked copy is the same file, so it is listed once.
  expect(view.skills.filter((entry) => entry.name === "review")).toHaveLength(2);
});

test("the hub serves the list read-only behind the browser session", async () => {
  const paths = resolveAxonPaths({ AXON_HOME: join(root, ".axon"), HOME: root });
  await skill(join(piSkills, "pdf-tools"), "name: pdf-tools\ndescription: Extract PDFs.");
  const hub: LocalHub = startLocalHub(paths, { userHome: root, catalogEnabled: false });
  try {
    const headers = { origin: hub.origin, "x-axon-hub": "1" };
    expect((await fetch(`${hub.origin}${BASE}/api/skills`, { headers })).status).toBe(401);
    const token = new URLSearchParams(new URL(hub.launchUrl).hash.slice(1)).get("token");
    const login = await fetch(`${hub.origin}${BASE}/api/session`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const response = await fetch(`${hub.origin}${BASE}/api/skills`, {
      headers: { ...headers, cookie },
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as SkillsView;
    expect(view.skills.map(({ name }) => name)).toEqual(["pdf-tools"]);
    const write = await fetch(`${hub.origin}${BASE}/api/skills`, {
      method: "POST",
      headers: {
        ...headers,
        cookie,
        "x-axon-hub-csrf": csrfToken,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(write.status).toBe(404);
  } finally {
    await hub.stop();
  }
});
